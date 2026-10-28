import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { npmReleaseAtom, npmReleaseMigrationsAtom } from "~/state/npmRelease";
import { downloadLocalUpdate, installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import { UpdateEverythingDialog } from "../sidebar/UpdateEverythingDialog";
import {
  channelSwitchBlockReason,
  channelSwitchLabel,
  type ChannelSwitchRelease,
} from "../sidebar/updateEverything.logic";
import { useUpdateEverything } from "../sidebar/useUpdateEverything";
import { prepareLocalTrackSwitch } from "./updateTrackSwitch.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Moves this app and every connected machine to `channel`. */
export function UpdateTrackSwitchDialog({
  channel,
  onClose,
}: {
  readonly channel: DesktopUpdateChannel;
  readonly onClose: () => void;
}) {
  // npm dist-tags match the desktop channel names.
  const release = useAtomValue(npmReleaseAtom(channel));
  const { environments } = useEnvironments();
  const versions = [
    APP_VERSION,
    ...environments.flatMap(({ serverConfig }) =>
      serverConfig ? [serverConfig.environment.serverVersion] : [],
    ),
  ];
  // Joining Nightly is never blocked, so it needs no migration lookups.
  // Frozen at open, so servers restarting mid-check cannot reset the dialog.
  const [versionsKey] = useState(() =>
    channel === "nightly" ? "" : [...new Set(versions)].join("\n"),
  );
  const migrations = useAtomValue(npmReleaseMigrationsAtom(versionsKey));
  const loaded = AsyncResult.isSuccess(release) && AsyncResult.isSuccess(migrations);
  if (loaded && release.value !== null) {
    return (
      <SwitchPlan
        release={{ channel, ...release.value }}
        migrationOf={(version) => migrations.value.get(version)}
        onClose={onClose}
      />
    );
  }
  const label = channelSwitchLabel(channel);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to {label}</AlertDialogTitle>
          <AlertDialogDescription>
            {AsyncResult.isFailure(release) || (loaded && release.value === null)
              ? `Could not find the latest ${label} release on npm. Try again later.`
              : "Checking releases…"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SwitchPlan({
  release,
  migrationOf,
  onClose,
}: {
  readonly release: ChannelSwitchRelease;
  readonly migrationOf: (version: string) => number | undefined;
  readonly onClose: () => void;
}) {
  const updateState = useDesktopUpdateState();
  const crossesLocal = desktopUpdateChannelOf(APP_VERSION) !== release.channel;
  // With its updater off (a .deb install, or no feed) this app stays put and only remotes move.
  const updatesOff = updateState?.enabled === false;
  // After a partial switch this app may already be on the track; then only remotes move.
  const switchesLocal = crossesLocal && !updatesOff;
  const [checking, setChecking] = useState(false);
  const everything = useUpdateEverything(switchesLocal ? release.version : null, {
    release,
    migrationOf,
  });
  const label = channelSwitchLabel(release.channel);
  const localBlocked = channelSwitchBlockReason(APP_VERSION, release, migrationOf(APP_VERSION));

  const run = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Stay open while the feed is checked; the run's own progress takes over after.
    setChecking(true);
    const fail = (description: string) =>
      toastManager.add(
        stackedThreadToast({ type: "error", title: `Could not switch to ${label}`, description }),
      );
    const prepared = await prepareLocalTrackSwitch(bridge, {
      channel: release.channel,
      version: release.version,
      reinstall: switchesLocal,
    });
    onClose();
    if (!prepared.ok) {
      fail(prepared.message);
      return;
    }
    const { local } = prepared;
    const result = await settlePromise(() =>
      everything.run(
        local === null
          ? {}
          : {
              ...(local.status === "available"
                ? {
                    downloadLocal: (reportError) =>
                      downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
                  }
                : {}),
              installLocal: (reportError) => installLocalUpdate(bridge, reportError),
            },
      ),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      fail(error instanceof Error ? error.message : "An unexpected error occurred.");
    }
  };

  return (
    <UpdateEverythingDialog
      open
      onOpenChange={(open) => !open && !checking && onClose()}
      title={`Switch to ${label}?`}
      version={release.version}
      providerCount={0}
      rows={everything.rows}
      notes={[
        ...(everything.rows.length === 0 && !crossesLocal
          ? [`Every connected machine is already on ${label}. This only saves the track.`]
          : []),
        ...(crossesLocal && updatesOff
          ? ["This app's updates are off here, so reinstall it yourself to switch."]
          : []),
        ...(switchesLocal && isMacPlatform(navigator.platform)
          ? ["If T3 Code does not reopen after it restarts, open it again."]
          : []),
      ]}
      restarts={everything.restarts}
      confirmLabel={checking ? "Checking…" : `Switch to ${label}`}
      busy={checking}
      disabledReason={
        !switchesLocal || localBlocked === null ? null : `This app cannot switch: ${localBlocked}.`
      }
      onConfirm={() => void run()}
    />
  );
}

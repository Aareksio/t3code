import type { DesktopBridge, DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";

type TrackSwitchBridge = Pick<DesktopBridge, "getUpdateState" | "setUpdateChannel">;

const isReady = (state: DesktopUpdateState, version: string) =>
  (state.status === "available" || state.status === "downloaded") &&
  (state.downloadedVersion ?? state.availableVersion) === version;

/** Saves the track, then, when this app must reinstall, finds its build of the checked `version`.
 * Saving even when nothing reinstalls lets picking the old track undo a partial switch. Any other
 * build restores the previous track, since the database guard only cleared `version`. */
export async function prepareLocalTrackSwitch(
  bridge: TrackSwitchBridge,
  input: {
    readonly channel: DesktopUpdateChannel;
    readonly version: string;
    readonly reinstall: boolean;
  },
): Promise<
  | { readonly ok: true; readonly local: DesktopUpdateState | null }
  | { readonly ok: false; readonly message: string }
> {
  let restore: DesktopUpdateChannel | null = null;
  try {
    const previous = (await bridge.getUpdateState()).channel;
    // Armed before saving: the desktop app persists the track before its feed check can fail.
    if (previous !== input.channel) restore = previous;
    // A build on another track always re-checks, with older releases allowed.
    const local = await setTrackWhenIdle(bridge, input.channel);
    if (!input.reinstall || isReady(local, input.version)) {
      restore = null;
      return { ok: true, local: input.reinstall ? local : null };
    }
    const found = local.downloadedVersion ?? local.availableVersion;
    return {
      ok: false,
      message:
        found !== null
          ? `This app found ${found}, not ${input.version}. Try again in a few minutes.`
          : (local.message ?? `This app found no build of ${input.version} to install.`),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The update track did not change.",
    };
  } finally {
    // Without the checked build, the poller must not keep working on the new track.
    if (restore !== null) await setTrackWhenIdle(bridge, restore).catch(() => undefined);
  }
}

const BUSY_ATTEMPTS = 10;
const BUSY_RETRY_MS = 1_000;

/** A background update check briefly holds the updater; wait it out instead of giving up. */
async function setTrackWhenIdle(bridge: TrackSwitchBridge, channel: DesktopUpdateChannel) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await bridge.setUpdateChannel(channel);
    } catch (error) {
      const busy = error instanceof Error && /in progress/i.test(error.message);
      if (!busy || attempt === BUSY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
    }
  }
}

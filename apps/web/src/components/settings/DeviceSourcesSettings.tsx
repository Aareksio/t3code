import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  AuthSettingsWriteScope,
  type DevicePlatform,
  type DeviceServiceState,
  type EasDeviceHostConfig,
  type EnvironmentId,
  type ServerSettingsPatch,
  type SimlockDeviceHostConfig,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CloudIcon,
  ContainerIcon,
  HardDriveIcon,
  LayersIcon,
  MoreVertical,
  PlusIcon,
  ServerIcon,
} from "lucide-react";

import { cn, randomUUID } from "../../lib/utils";
import { deviceEnvironment } from "../../state/device";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { DeviceHostEditor } from "./DeviceHostEditor";
import { updateDeviceHosts, groupDeviceHosts } from "./deviceHostsSettings.logic";
import { EasDeviceHostEditor } from "./EasDeviceHostEditor";
import {
  easSessionLimits,
  newEasDeviceHost,
  updateEasDeviceHosts,
} from "./easDeviceHostsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { SimlockDeviceHostEditor } from "./SimlockDeviceHostEditor";
import {
  newSimlockDeviceHost,
  planSimlockDeviceHostSave,
  simlockLeaseLimits,
  updateSimlockDeviceHosts,
  type SimlockTokenEntry,
} from "./simlockDeviceHostsSettings.logic";
import { useHostConnectionChecks } from "./useHostConnectionChecks";

const deviceHostStatesAtom = environmentAtomList("web-device-host-states", (environmentId) =>
  deviceEnvironment.state({ environmentId, input: {} }),
);

const PLATFORM_LABELS: Record<DevicePlatform, string> = { ios: "iOS", android: "Android" };

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** How one source stands on one environment. `none` is not a problem: the source is not there. */
interface SourceStatus {
  readonly tone: "ready" | "pending" | "warning" | "error" | "none";
  readonly label: string;
  readonly detail?: string | undefined;
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}

interface SourceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: SourceStatus;
}

interface SourceRow {
  readonly key: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly kind?: string;
  readonly description: ReactNode;
  readonly environments: ReadonlyArray<SourceEnvironment>;
  readonly actions?: ReactNode;
}

type Editing =
  | {
      readonly kind: "ssh";
      readonly host: SshDeviceHostConfig;
      readonly original: SshDeviceHostConfig | null;
    }
  | { readonly kind: "eas"; readonly host: EasDeviceHostConfig; readonly isNew: boolean }
  | { readonly kind: "simlock"; readonly host: SimlockDeviceHostConfig; readonly isNew: boolean };

/**
 * A configured host's status on one environment, from that environment's device state. EAS and
 * Simlock hosts connect on demand, so an idle one is ready; an idle SSH host has not connected yet.
 */
function hostStatus(
  state: DeviceServiceState | undefined,
  hostId: string,
  onDemand = false,
): SourceStatus {
  if (!state) return { tone: "pending", label: "Loading" };
  if (state.hostStatus === "disabled") return { tone: "none", label: "Devices off" };
  const status = state.hostStatuses[hostId];
  switch (status?.status) {
    case "ready":
      return status.androidDiscoveryIncomplete
        ? { tone: "warning", label: "Android list incomplete", detail: status.detail }
        : { tone: "ready", label: "Ready" };
    case "installing":
    case "starting":
      return { tone: "pending", label: "Starting", detail: status.detail };
    case "failed":
      return { tone: "error", label: "Failed", detail: status.detail };
    default:
      return { tone: "ready", label: onDemand ? "Ready" : "Not connected yet" };
  }
}

/**
 * Every device source the selected environments can open, one row each. A source configured on
 * several environments is one row; how it stands on each lives in the row's breakdown.
 */
export function DeviceSourcesSettings(props: {
  readonly supportsEas: boolean;
  readonly supportsSimlock: boolean;
}) {
  const { scope, environments, connectedEnvironments, environment: primary } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (environment: (typeof environments)[number]) =>
    settingsScopeEnvironmentLabel(environment, environments);
  const targets = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: label(environment),
    connected: environment.connection.phase === "connected",
  }));
  const { testConnection } = useHostConnectionChecks(targets);
  const ids = connectedEnvironments.map((environment) => environment.environmentId);
  const results = useAtomValue(deviceHostStatesAtom(environmentIdsKey(ids)));
  const members = connectedEnvironments.map((environment, index) => {
    const result = results[index];
    return {
      environmentId: environment.environmentId,
      label: label(environment),
      settings: environment.serverConfig?.settings,
      state: result ? Option.getOrUndefined(AsyncResult.value(result)) : undefined,
    };
  });
  const simlockEnabled = members.some((member) => member.settings?.simlockDeviceHostsEnabled);
  const disconnected = environments.length > connectedEnvironments.length;
  const disabled = projectScope || busy || members.length === 0 || disconnected;

  /** Writes one settings patch per environment; reports the environments it could not change. */
  const write = async (
    patches: ReadonlyArray<{ environmentId: EnvironmentId; patch: ServerSettingsPatch }>,
    failedTitle: string,
  ) => {
    const name = (environmentId: EnvironmentId) =>
      members.find((member) => member.environmentId === environmentId)?.label ?? environmentId;
    const unwritable = patches.filter(
      (patch) => !readEnvironmentScope(patch.environmentId, AuthSettingsWriteScope),
    );
    if (unwritable.length > 0) {
      toastManager.add({
        type: "error",
        title: failedTitle,
        description: `This connection cannot change settings on ${unwritable.map((patch) => name(patch.environmentId)).join(", ")}.`,
      });
      return false;
    }
    setBusy(true);
    const outcomes = await Promise.all(
      patches.map((patch) =>
        update({ environmentId: patch.environmentId, input: { patch: patch.patch } }),
      ),
    );
    setBusy(false);
    const failed = patches.flatMap((patch, index) => {
      const outcome = outcomes[index];
      return outcome && outcome._tag === "Failure"
        ? [`${name(patch.environmentId)}: ${failureMessage(outcome.cause)}`]
        : [];
    });
    if (failed.length === 0) return true;
    toastManager.add({ type: "error", title: failedTitle, description: failed.join("\n") });
    return false;
  };

  const saveSsh = async (host: SshDeviceHostConfig, remove: boolean, original = host) => {
    try {
      const saved = await write(
        members.map((member) => ({
          environmentId: member.environmentId,
          patch: {
            deviceHosts: updateDeviceHosts(
              member.settings?.deviceHosts ?? [],
              host,
              remove,
              original,
            ),
          },
        })),
        remove ? "Device host not removed everywhere" : "Device host not saved everywhere",
      );
      if (saved) setEditing(null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Device host not saved",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const saveEas = async (
    host: EasDeviceHostConfig,
    remove: boolean,
    previous?: EasDeviceHostConfig,
  ) => {
    // A saved token arrives redacted. Environments that hold it keep it; one that does not falls
    // back to its own server's Expo login rather than storing the redacted value.
    const keptToken = previous !== undefined && host.accessToken === previous.accessToken;
    const saved = await write(
      members.map((member) => {
        const hosts = member.settings?.easDeviceHosts ?? [];
        const holds = hosts.some((candidate) => candidate.id === host.id);
        const forHere = !remove && keptToken && !holds ? { ...host, accessToken: "" } : host;
        return {
          environmentId: member.environmentId,
          patch: { easDeviceHosts: updateEasDeviceHosts(hosts, forHere, remove) },
        };
      }),
      remove ? "EAS host not removed everywhere" : "EAS host not saved everywhere",
    );
    if (saved) setEditing(null);
  };

  const simlockEnvironments = members.map((member) => ({
    environmentId: member.environmentId,
    label: member.label,
    hosts: member.settings?.simlockDeviceHosts ?? [],
  }));
  const saveSimlock = async (
    host: SimlockDeviceHostConfig,
    tokens: ReadonlyMap<EnvironmentId, SimlockTokenEntry>,
  ) => {
    const plan = planSimlockDeviceHostSave(simlockEnvironments, host, tokens);
    if ("problem" in plan) return;
    const saved = await write(
      plan.patches.map((patch) => ({
        environmentId: patch.environmentId,
        patch: { simlockDeviceHosts: patch.hosts },
      })),
      "Simlock host not saved everywhere",
    );
    if (saved) setEditing(null);
  };
  const removeSimlock = (host: SimlockDeviceHostConfig) =>
    void write(
      simlockEnvironments
        .filter((environment) => environment.hosts.some((candidate) => candidate.id === host.id))
        .map((environment) => ({
          environmentId: environment.environmentId,
          patch: { simlockDeviceHosts: updateSimlockDeviceHosts(environment.hosts, host, true) },
        })),
      "Simlock host not removed everywhere",
    );

  const retry = (environmentId: EnvironmentId, hostId: string) =>
    void list({ environmentId, input: { retryHostId: hostId } });

  const rowActions = (onEdit: () => void, onRemove: () => void, extra?: ReactNode) => (
    <>
      <Button size="sm" variant="outline" disabled={disabled} onClick={onEdit}>
        Edit
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button size="icon-sm" variant="ghost-muted" disabled={disabled} aria-label="More" />
          }
        >
          <MoreVertical />
        </MenuTrigger>
        <MenuPopup align="end">
          {extra}
          <MenuItem variant="destructive" onClick={onRemove}>
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );

  const rows: SourceRow[] = [];

  rows.push({
    key: "local",
    icon: <HardDriveIcon className="size-3.5" />,
    title: "Local simulators",
    description:
      members.length === 1
        ? platformsSummary(members[0]?.state, "local") || "Runtimes installed on this machine"
        : localPlatformsAcross(members) || "Runtimes installed on each environment's machine",
    environments: members.map((member) => {
      const state = member.state;
      let status: SourceStatus;
      if (!state) status = { tone: "pending", label: "Loading" };
      else if (state.hostStatus === "disabled") status = { tone: "none", label: "Devices off" };
      else {
        const local = state.hosts.find((host) => host.kind === "local");
        const failure = local ? hostStatus(state, local.id) : undefined;
        status =
          failure?.tone === "error"
            ? {
                ...failure,
                action: {
                  label: "Refresh",
                  run: () => void list({ environmentId: member.environmentId, input: {} }),
                },
              }
            : local?.platforms.some((platform) => platform.available)
              ? { tone: "ready", label: "Ready" }
              : { tone: "none", label: "No runtimes" };
      }
      return { environmentId: member.environmentId, label: member.label, status };
    }),
  });

  const sshGroups =
    groupDeviceHosts(
      members.map((member) => ({
        environmentId: member.environmentId,
        label: member.label,
        hosts: member.settings?.deviceHosts ?? [],
      })),
    ) ??
    // Hosts that cannot be matched across environments stay one row per environment.
    members.flatMap((member) =>
      (member.settings?.deviceHosts ?? []).map((host) => ({
        host,
        members: [{ environmentId: member.environmentId, label: member.label, host }],
      })),
    );
  for (const group of sshGroups) {
    const host = group.host;
    rows.push({
      key: `ssh:${host.id}:${group.members.map((member) => member.environmentId).join(",")}`,
      icon: <ServerIcon className="size-3.5" />,
      title: host.label,
      kind: "SSH",
      description: host.target,
      environments: members.map((member) => {
        const held = group.members.find(
          (candidate) => candidate.environmentId === member.environmentId,
        );
        if (!held)
          return {
            environmentId: member.environmentId,
            label: member.label,
            status: { tone: "none", label: "Not added" },
          };
        const status = hostStatus(member.state, held.host.id);
        return {
          environmentId: member.environmentId,
          label: member.label,
          status:
            status.tone === "error" && member.state?.supportsHostRetry
              ? {
                  ...status,
                  label: "Can't connect",
                  action: { label: "Retry", run: () => retry(member.environmentId, held.host.id) },
                }
              : status,
        };
      }),
      actions: rowActions(
        () => setEditing({ kind: "ssh", host, original: host }),
        () => void saveSsh(host, true),
        <MenuItem onClick={() => void testConnection(host)}>Test connection</MenuItem>,
      ),
    });
  }

  if (props.supportsEas) {
    const easHosts = new Map<string, EasDeviceHostConfig>();
    for (const member of members)
      for (const host of member.settings?.easDeviceHosts ?? [])
        if (!easHosts.has(host.id)) easHosts.set(host.id, host);
    for (const host of easHosts.values()) {
      rows.push({
        key: `eas:${host.id}`,
        icon: <CloudIcon className="size-3.5" />,
        title: host.label,
        kind: "EAS",
        description: easSessionLimits(host),
        environments: members.map((member) => ({
          environmentId: member.environmentId,
          label: member.label,
          status: (member.settings?.easDeviceHosts ?? []).some(
            (candidate) => candidate.id === host.id,
          )
            ? hostStatus(member.state, host.id, true)
            : { tone: "none", label: "Not added" },
        })),
        actions: rowActions(
          () => setEditing({ kind: "eas", host, isNew: false }),
          () => void saveEas(host, true),
        ),
      });
    }
  }

  if (props.supportsSimlock && simlockEnabled) {
    const simlockHosts = new Map<string, SimlockDeviceHostConfig>();
    for (const environment of simlockEnvironments)
      for (const host of environment.hosts)
        if (!simlockHosts.has(host.id)) simlockHosts.set(host.id, host);
    for (const host of simlockHosts.values()) {
      const edit = () => setEditing({ kind: "simlock", host, isNew: false });
      rows.push({
        key: `simlock:${host.id}`,
        icon: <ContainerIcon className="size-3.5" />,
        title: host.label,
        kind: "Simlock",
        description: `${host.gatewayUrl.replace(/^https?:\/\//, "")} · ${simlockLeaseLimits(host)}`,
        environments: simlockEnvironments.map((environment) => {
          const member = members.find(
            (candidate) => candidate.environmentId === environment.environmentId,
          );
          const held = environment.hosts.find((candidate) => candidate.id === host.id);
          const status: SourceStatus = !held
            ? { tone: "none", label: "Not added" }
            : held.agentToken === ""
              ? {
                  tone: "warning",
                  label: "No agent token",
                  action: { label: "Add token", run: edit },
                }
              : hostStatus(member?.state, host.id, true);
          return { environmentId: environment.environmentId, label: environment.label, status };
        }),
        actions: rowActions(edit, () => removeSimlock(host)),
      });
    }
  }

  const addMenu = (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="outline" disabled={disabled || editing !== null} />}
      >
        <PlusIcon className="size-3.5" /> Add source
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          onClick={() =>
            setEditing({
              kind: "ssh",
              host: { kind: "ssh", id: randomUUID(), label: "", target: "" },
              original: null,
            })
          }
        >
          Machine over SSH
        </MenuItem>
        {props.supportsEas ? (
          <MenuItem
            onClick={() =>
              setEditing({ kind: "eas", host: newEasDeviceHost(randomUUID()), isNew: true })
            }
          >
            EAS Simulator
          </MenuItem>
        ) : null}
        {props.supportsSimlock && simlockEnabled ? (
          <MenuItem
            onClick={() =>
              setEditing({ kind: "simlock", host: newSimlockDeviceHost(randomUUID()), isNew: true })
            }
          >
            Simlock pool (alpha)
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );

  return (
    <SettingsSection id="device-sources" title="Device sources" headerAction={addMenu}>
      {projectScope ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground sm:px-5">
          Device sources belong to environments. Select an environment to change them.
        </p>
      ) : disconnected ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground sm:px-5">
          Connect every selected environment to change device sources.
        </p>
      ) : null}
      {rows.map((row) => (
        <DeviceSourceRow key={row.key} row={row} />
      ))}
      {editing?.kind === "ssh" ? (
        <DeviceHostEditor
          key={editing.host.id}
          host={editing.host}
          isNew={editing.original === null}
          targets={targets}
          busy={busy}
          onSave={(host) => void saveSsh(host, false, editing.original ?? host)}
          onClose={() => setEditing(null)}
        />
      ) : editing?.kind === "eas" && primary ? (
        <EasDeviceHostEditor
          key={editing.host.id}
          environmentId={primary.environmentId}
          host={editing.host}
          isNew={editing.isNew}
          busy={busy}
          onSave={(host) => void saveEas(host, false, editing.isNew ? undefined : editing.host)}
          onClose={() => setEditing(null)}
        />
      ) : editing?.kind === "simlock" ? (
        <SimlockDeviceHostEditor
          key={editing.host.id}
          host={editing.host}
          isNew={editing.isNew}
          environments={simlockEnvironments}
          busy={busy}
          onSave={(host, tokens) => void saveSimlock(host, tokens)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function platformsSummary(state: DeviceServiceState | undefined, kind: "local") {
  const local = state?.hosts.find((host) => host.kind === kind);
  return (local?.platforms ?? [])
    .filter((platform) => platform.available)
    .map((platform) => PLATFORM_LABELS[platform.platform])
    .join(" · ");
}

/** "iOS on mbp, macmini · Android on mbp": which machines have which runtimes. */
function localPlatformsAcross(
  members: ReadonlyArray<{ label: string; state: DeviceServiceState | undefined }>,
) {
  return (["ios", "android"] as const)
    .flatMap((platform) => {
      const holders = members.filter((member) =>
        member.state?.hosts
          .find((host) => host.kind === "local")
          ?.platforms.some((candidate) => candidate.platform === platform && candidate.available),
      );
      return holders.length > 0
        ? [`${PLATFORM_LABELS[platform]} on ${holders.map((member) => member.label).join(", ")}`]
        : [];
    })
    .join(" · ");
}

const DOT_CLASSES: Record<SourceStatus["tone"], string> = {
  ready: "bg-success",
  pending: "bg-muted-foreground animate-none",
  warning: "bg-warning",
  error: "bg-destructive",
  none: "bg-muted-foreground/50",
};

function StatusDot(props: { tone: SourceStatus["tone"] }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASSES[props.tone])}
    />
  );
}

/** One status for the row: the shared one, or how many of the environments that have it are ready. */
function summarize(environments: ReadonlyArray<SourceEnvironment>): SourceStatus {
  const present = environments.filter((environment) => environment.status.tone !== "none");
  const first = environments[0]?.status;
  if (first && environments.every((environment) => environment.status.label === first.label))
    return first;
  if (present.length === 0)
    return { tone: "none", label: environments.length > 0 ? "Off" : "None" };
  const ready = present.filter((environment) => environment.status.tone === "ready").length;
  const tone = present.some((environment) => environment.status.tone === "error")
    ? "error"
    : present.some((environment) => environment.status.tone === "warning")
      ? "warning"
      : present.some((environment) => environment.status.tone === "pending")
        ? "pending"
        : "ready";
  return {
    tone,
    label:
      ready === present.length ? `Ready on ${ready}` : `Ready on ${ready} of ${present.length}`,
  };
}

function DeviceSourceRow(props: { row: SourceRow }) {
  const { row } = props;
  const several = row.environments.length > 1;
  const summary = summarize(row.environments);
  const differs =
    several && new Set(row.environments.map((environment) => environment.status.label)).size > 1;
  // Problems get a line of their own, with the fix beside them.
  const problems = row.environments.filter(
    (environment) => environment.status.tone === "error" || environment.status.tone === "warning",
  );
  const groups = new Map<string, SourceEnvironment[]>();
  for (const environment of row.environments)
    groups.set(environment.status.label, [
      ...(groups.get(environment.status.label) ?? []),
      environment,
    ]);
  return (
    <div className="flex items-center gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
        {row.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-medium">{row.title}</p>
          {row.kind ? (
            <span className="shrink-0 rounded border border-border px-1 text-3xs uppercase tracking-wide text-muted-foreground">
              {row.kind}
            </span>
          ) : null}
          {differs ? (
            <Popover>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          aria-label="Differs across environments. Show each environment"
                        />
                      }
                    />
                  }
                >
                  <LayersIcon className="size-3 text-warning" />
                </TooltipTrigger>
                <TooltipPopup side="top">Differs across environments</TooltipPopup>
              </Tooltip>
              <PopoverPopup align="start" width="md" padding="none">
                <div className="divide-y divide-border/60">
                  {[...groups.entries()].map(([status, environments]) => (
                    <section key={status} className="px-3 py-2.5">
                      <h4 className="pb-1 text-xs font-medium text-muted-foreground">
                        {environments.map((environment) => environment.label).join(" · ")}
                      </h4>
                      <p className="flex items-center gap-1.5 text-sm">
                        <StatusDot tone={environments[0]!.status.tone} />
                        {status}
                      </p>
                      {environments[0]?.status.detail ? (
                        <p className="mt-1 whitespace-pre-line break-words text-xs text-muted-foreground">
                          {environments[0].status.detail}
                        </p>
                      ) : null}
                    </section>
                  ))}
                </div>
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">{row.description}</p>
        {problems.map((environment) => (
          <p
            key={environment.environmentId}
            role="status"
            className="mt-1 flex flex-wrap items-center gap-1.5 text-xs"
          >
            <StatusDot tone={environment.status.tone} />
            <span className="min-w-0 break-words">
              {several ? `${environment.label}: ` : ""}
              {environment.status.detail && !several
                ? environment.status.detail
                : environment.status.label}
            </span>
            {environment.status.action ? (
              <InlineButton onClick={environment.status.action.run}>
                {environment.status.action.label}
              </InlineButton>
            ) : null}
          </p>
        ))}
      </div>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot tone={summary.tone} />
        {summary.label}
      </span>
      {row.actions ? <div className="flex shrink-0 items-center gap-1">{row.actions}</div> : null}
    </div>
  );
}

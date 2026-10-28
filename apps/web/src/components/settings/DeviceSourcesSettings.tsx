import { useAtomValue } from "@effect/atom-react";
import { Fragment, useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  AuthSettingsWriteScope,
  type DevicePlatform,
  type DevicePlatformAvailability,
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
import { AndroidIcon, AppleIcon } from "../Icons";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
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

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** Something on one environment that is in progress or needs a fix; a working source has none. */
interface SourceStatus {
  readonly tone: "pending" | "warning" | "error";
  readonly label: string;
  readonly detail?: string | undefined;
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}

/** A source on one environment whose devices are on. */
interface SourceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly added: boolean;
  readonly status?: SourceStatus | undefined;
  /** Unknown until the environment's hub has reached the source. */
  readonly platforms?: ReadonlyArray<DevicePlatformAvailability> | undefined;
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

/** What a configured host is doing on one environment, when it is not simply working. */
function hostStatus(
  state: DeviceServiceState | undefined,
  hostId: string,
): SourceStatus | undefined {
  if (!state) return { tone: "pending", label: "Loading" };
  const status = state.hostStatuses[hostId];
  switch (status?.status) {
    case "ready":
      return status.androidDiscoveryIncomplete
        ? { tone: "warning", label: "Android list may be incomplete", detail: status.detail }
        : undefined;
    case "installing":
    case "starting":
      return { tone: "pending", label: "Starting", detail: status.detail };
    case "failed":
      return { tone: "error", label: "Failed", detail: status.detail };
    default:
      return undefined;
  }
}

const hostPlatforms = (state: DeviceServiceState | undefined, hostId: string) =>
  state?.hosts.find((host) => host.id === hostId)?.platforms;

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
  // Environments with devices off are left out: the switch above already says so.
  const active = members.filter((member) => member.settings?.enableDeviceSupport);
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

  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const testSsh = async (host: SshDeviceHostConfig) => {
    setTesting((current) => new Set(current).add(host.id));
    const checked = await testConnection(host).finally(() =>
      setTesting((current) => {
        const next = new Set(current);
        next.delete(host.id);
        return next;
      }),
    );
    if (!checked) return;
    const failed = targets.filter((target) => checked[target.environmentId]?.status === "failed");
    toastManager.add({
      type: failed.length ? "error" : "success",
      title: failed.length
        ? `${host.label}: ${failed.length} of ${targets.length} environments failed`
        : `${host.label}: connection checks passed`,
      description: failed.length
        ? failed
            .map((target) => {
              const result = checked[target.environmentId];
              return `${target.label}: ${result?.status === "failed" ? result.error : "failed"}`;
            })
            .join("\n")
        : "Connected or already available locally on each selected environment.",
    });
  };

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
      members.length > 1
        ? "Simulators and emulators installed on each environment's own machine."
        : "Simulators and emulators installed on this environment's machine.",
    environments: active.map((member) => {
      const local = member.state?.hosts.find((host) => host.kind === "local");
      const status = local ? hostStatus(member.state, local.id) : hostStatus(member.state, "");
      return {
        environmentId: member.environmentId,
        label: member.label,
        added: true,
        platforms: local?.platforms,
        status:
          status?.tone === "error"
            ? {
                ...status,
                action: {
                  label: "Refresh",
                  run: () => void list({ environmentId: member.environmentId, input: {} }),
                },
              }
            : status,
      };
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
      environments: active.map((member) => {
        const held = group.members.find(
          (candidate) => candidate.environmentId === member.environmentId,
        );
        if (!held)
          return { environmentId: member.environmentId, label: member.label, added: false };
        const status = testing.has(host.id)
          ? ({ tone: "pending", label: "Testing connection" } as const)
          : hostStatus(member.state, held.host.id);
        return {
          environmentId: member.environmentId,
          label: member.label,
          added: true,
          platforms: hostPlatforms(member.state, held.host.id),
          status:
            status?.tone === "error" && member.state?.supportsHostRetry
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
        <MenuItem onClick={() => void testSsh(host)}>Test connection</MenuItem>,
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
        environments: active.map((member) => {
          const added = (member.settings?.easDeviceHosts ?? []).some(
            (candidate) => candidate.id === host.id,
          );
          return {
            environmentId: member.environmentId,
            label: member.label,
            added,
            ...(added
              ? {
                  status: hostStatus(member.state, host.id),
                  platforms: hostPlatforms(member.state, host.id),
                }
              : {}),
          };
        }),
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
        environments: active.map((member) => {
          const held = (member.settings?.simlockDeviceHosts ?? []).find(
            (candidate) => candidate.id === host.id,
          );
          if (!held)
            return { environmentId: member.environmentId, label: member.label, added: false };
          return {
            environmentId: member.environmentId,
            label: member.label,
            added: true,
            platforms: hostPlatforms(member.state, host.id),
            status:
              held.agentToken === ""
                ? ({
                    tone: "warning",
                    label: "No agent token",
                    action: { label: "Add token", run: edit },
                  } as const)
                : hostStatus(member.state, host.id),
          };
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

const PLATFORMS = [
  { platform: "ios", label: "iOS", Icon: AppleIcon },
  { platform: "android", label: "Android", Icon: AndroidIcon },
] as const satisfies ReadonlyArray<{ platform: DevicePlatform; label: string; Icon: unknown }>;

/**
 * The platforms a source offers, as icons. An icon is dimmed where no environment has the
 * platform and carries a warning mark where only some do; hovering shows each environment.
 */
function SourcePlatforms(props: { title: string; environments: ReadonlyArray<SourceEnvironment> }) {
  const added = props.environments.filter((environment) => environment.added);
  const known = added.filter((environment) => environment.platforms !== undefined);
  const shown = PLATFORMS.filter(({ platform }) =>
    known.some((environment) =>
      environment.platforms?.some((candidate) => candidate.platform === platform),
    ),
  );
  if (shown.length === 0) return null;
  const availableOn = (platform: DevicePlatform) =>
    known.filter((environment) =>
      environment.platforms?.some(
        (candidate) => candidate.platform === platform && candidate.available,
      ),
    ).length;
  const several = props.environments.length > 1;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${props.title}: ${shown
              .map(
                ({ platform, label }) => `${label} on ${availableOn(platform)} of ${known.length}`,
              )
              .join(", ")}. Show each environment`}
            className="flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5 text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {shown.map(({ platform, Icon }) => {
          const count = availableOn(platform);
          return (
            <span key={platform} className={cn("relative", count === 0 && "opacity-40")}>
              <Icon className={cn("size-3.5", platform === "ios" && "-translate-y-px")} />
              {count > 0 && count < known.length ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-warning ring-2 ring-background"
                />
              ) : null}
            </span>
          );
        })}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" padding="none">
        <div className="divide-y divide-border/60">
          {props.environments.map((environment) => (
            <section key={environment.environmentId} className="px-3 py-2.5">
              {several ? (
                <h4 className="pb-1 text-xs font-medium text-muted-foreground">
                  {environment.label}
                </h4>
              ) : null}
              {!environment.added ? (
                <p className="text-xs text-muted-foreground">Not added here</p>
              ) : !environment.platforms ? (
                <p className="text-xs text-muted-foreground">Not reached yet</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  {PLATFORMS.map(({ platform, label }) => {
                    const availability = environment.platforms?.find(
                      (candidate) => candidate.platform === platform,
                    );
                    return (
                      <Fragment key={platform}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className={availability?.available ? "" : "text-muted-foreground"}>
                          {availability?.available
                            ? "Available"
                            : (availability?.reason ?? "Not available")}
                        </dd>
                      </Fragment>
                    );
                  })}
                </dl>
              )}
            </section>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function DeviceSourceRow(props: { row: SourceRow }) {
  const { row } = props;
  const several = row.environments.length > 1;
  const issues = row.environments.filter(
    (environment): environment is SourceEnvironment & { status: SourceStatus } =>
      environment.status !== undefined,
  );
  const problems = issues.filter((environment) => environment.status.tone !== "pending");
  const pending = issues.find((environment) => environment.status.tone === "pending");
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
        </div>
        <p className="truncate text-xs text-muted-foreground">{row.description}</p>
        {problems.map((environment) => (
          <p
            key={environment.environmentId}
            role="status"
            className={cn(
              "mt-1 flex flex-wrap items-center gap-1.5 text-xs",
              environment.status.tone === "error" ? "text-destructive" : "text-warning",
            )}
          >
            <span className="min-w-0 break-words">
              {several ? `${environment.label}: ` : ""}
              {!several && environment.status.detail
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
      {pending ? (
        <span
          role="status"
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Spinner size="xs" />
          {pending.status.label}
        </span>
      ) : (
        <SourcePlatforms title={row.title} environments={row.environments} />
      )}
      {row.actions ? <div className="flex shrink-0 items-center gap-1">{row.actions}</div> : null}
    </div>
  );
}

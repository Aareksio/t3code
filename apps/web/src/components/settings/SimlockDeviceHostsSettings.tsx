import { useId, useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SimlockDeviceHostConfig,
} from "@t3tools/contracts";
import { PlusIcon, ServerIcon, XIcon } from "lucide-react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import {
  groupSimlockDeviceHosts,
  newSimlockDeviceHost,
  planSimlockDeviceHostSave,
  simlockLeaseLimits,
  updateSimlockDeviceHosts,
  type SimlockHostEnvironment,
  type SimlockTokenEntry,
} from "./simlockDeviceHostsSettings.logic";

const SIMLOCK_URL = "https://incubator.callstack.com/simlock/";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const joinLabels = (labels: ReadonlyArray<string>) => labels.join(", ");

/**
 * A host's name, gateway, and limits are saved to every selected environment; its agent token is
 * each environment's own, because the token is the requester Simlock counts leases against.
 */
export function SimlockDeviceHostsSettings(props: { environmentId: EnvironmentId | null }) {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const canConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const hostEnvironments: ReadonlyArray<SimlockHostEnvironment> = connectedEnvironments.map(
    (environment) => ({
      environmentId: environment.environmentId,
      label: settingsScopeEnvironmentLabel(environment, environments),
      hosts: environment.serverConfig?.settings.simlockDeviceHosts ?? [],
    }),
  );
  const disconnected = environments
    .filter((environment) => !connectedEnvironments.includes(environment))
    .map((environment) => settingsScopeEnvironmentLabel(environment, environments));
  const groups = groupSimlockDeviceHosts(hostEnvironments);
  const [editing, setEditing] = useState<{ host: SimlockDeviceHostConfig; isNew: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const disabled =
    !canConfigure ||
    projectScope ||
    busy ||
    hostEnvironments.length === 0 ||
    disconnected.length > 0;

  const write = async (
    patches: ReadonlyArray<{
      environmentId: EnvironmentId;
      hosts: ReadonlyArray<SimlockDeviceHostConfig>;
    }>,
    failedTitle: string,
  ) => {
    const label = (environmentId: EnvironmentId) =>
      hostEnvironments.find((environment) => environment.environmentId === environmentId)?.label ??
      environmentId;
    const unwritable = patches.filter(
      (patch) => !readEnvironmentScope(patch.environmentId, AuthSettingsWriteScope),
    );
    if (unwritable.length > 0) {
      toastManager.add({
        type: "error",
        title: failedTitle,
        description: `This connection cannot change settings on ${joinLabels(unwritable.map((patch) => label(patch.environmentId)))}.`,
      });
      return false;
    }
    setBusy(true);
    const results = await Promise.all(
      patches.map((patch) =>
        update({
          environmentId: patch.environmentId,
          input: { patch: { simlockDeviceHosts: patch.hosts } },
        }),
      ),
    );
    setBusy(false);
    const failed = patches.flatMap((patch, index) => {
      const result = results[index];
      return result && result._tag === "Failure"
        ? [`${label(patch.environmentId)}: ${failureMessage(result.cause)}`]
        : [];
    });
    if (failed.length === 0) return true;
    toastManager.add({ type: "error", title: failedTitle, description: failed.join("\n") });
    return false;
  };

  const save = async (
    host: SimlockDeviceHostConfig,
    tokens: ReadonlyMap<EnvironmentId, SimlockTokenEntry>,
  ) => {
    const plan = planSimlockDeviceHostSave(hostEnvironments, host, tokens);
    if ("problem" in plan) return;
    if (await write(plan.patches, "Simlock host not saved on every environment")) setEditing(null);
  };

  const remove = (host: SimlockDeviceHostConfig) =>
    void write(
      hostEnvironments
        .filter((environment) => environment.hosts.some((candidate) => candidate.id === host.id))
        .map((environment) => ({
          environmentId: environment.environmentId,
          hosts: updateSimlockDeviceHosts(environment.hosts, host, true),
        })),
      "Simlock host not removed from every environment",
    );

  return (
    <SettingsRow
      id="simlock-device-hosts"
      title="Simlock (alpha)"
      serverScoped
      settingKeys={["simlockDeviceHosts"]}
      description={
        <>
          Lease simulators and emulators from your own pool. Alpha:{" "}
          <a
            href={SIMLOCK_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          is new and unreleased, and this integration may change or stop working. T3 Code does not
          install Simlock; point it at a gateway you run.
        </>
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || editing !== null}
          onClick={() => setEditing({ host: newSimlockDeviceHost(randomUUID()), isNew: true })}
        >
          <PlusIcon className="size-3.5" /> Add Simlock host
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {disconnected.length > 0 ? (
          <p className="pb-2 text-sm text-muted-foreground">
            Connect {joinLabels(disconnected)} to change Simlock hosts on the selected environments.
          </p>
        ) : null}
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Simlock hosts.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {groups.map(({ host, environments: holders }) => {
              const missing = hostEnvironments
                .filter(
                  (environment) =>
                    !holders.some(
                      (holder) =>
                        holder.environmentId === environment.environmentId && holder.hasToken,
                    ),
                )
                .map((environment) => environment.label);
              return (
                <li
                  key={host.id}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate font-medium">
                      <ServerIcon className="size-3.5 shrink-0" /> {host.label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {host.gatewayUrl} · {simlockLeaseLimits(host)}
                    </p>
                    {hostEnvironments.length > 1 || missing.length > 0 ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {missing.length === 0
                          ? `Token on ${joinLabels(holders.map((holder) => holder.label))}`
                          : `No token on ${joinLabels(missing)}`}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => setEditing({ host, isNew: false })}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={disabled}
                      onClick={() => remove(host)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {editing ? (
          <SimlockDeviceHostEditor
            key={editing.host.id}
            host={editing.host}
            isNew={editing.isNew}
            environments={hostEnvironments}
            busy={busy}
            onSave={(host, tokens) => void save(host, tokens)}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

function SimlockDeviceHostEditor(props: {
  host: SimlockDeviceHostConfig;
  isNew: boolean;
  environments: ReadonlyArray<SimlockHostEnvironment>;
  busy: boolean;
  onSave: (
    host: SimlockDeviceHostConfig,
    tokens: ReadonlyMap<EnvironmentId, SimlockTokenEntry>,
  ) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.host);
  const savedToken = (environment: SimlockHostEnvironment) =>
    environment.hosts.some((host) => host.id === props.host.id && host.agentToken !== "");
  const [tokens, setTokens] = useState<ReadonlyMap<EnvironmentId, SimlockTokenEntry>>(
    () =>
      new Map(
        props.environments.map((environment) => [
          environment.environmentId,
          savedToken(environment) ? { kind: "saved" } : { kind: "cleared" },
        ]),
      ),
  );
  const next: SimlockDeviceHostConfig = {
    ...draft,
    label: draft.label.trim(),
    gatewayUrl: draft.gatewayUrl.trim(),
  };
  const plan = planSimlockDeviceHostSave(props.environments, next, tokens);
  const problem = "problem" in plan ? plan.problem : null;
  const several = props.environments.length > 1;

  const limit = (
    field: "maxLeases" | "maxLeaseMinutes",
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="block space-y-1.5">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={draft[field]}
        disabled={props.busy}
        onChange={(event) => {
          const value = Number(event.target.value);
          setDraft((current) => ({ ...current, [field]: value }));
        }}
      />
    </label>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!props.busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null && !props.busy) props.onSave(next, tokens);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.isNew ? "Add Simlock host" : "Edit Simlock host"}</DialogTitle>
            <DialogDescription>
              {several
                ? "Each selected environment's server leases devices from your Simlock gateway with its own agent token, and releases them when they close."
                : "The environment's server leases devices from your Simlock gateway and releases them when they close."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <Input
                autoFocus
                required
                value={draft.label}
                disabled={props.busy}
                onChange={(event) => {
                  const label = event.target.value;
                  setDraft((current) => ({ ...current, label }));
                }}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Gateway URL</span>
              <Input
                required
                type="url"
                placeholder="https://gateway.example.ts.net:4700"
                value={draft.gatewayUrl}
                disabled={props.busy}
                onChange={(event) => {
                  const gatewayUrl = event.target.value;
                  setDraft((current) => ({ ...current, gatewayUrl }));
                }}
              />
            </label>
            <div className="space-y-3">
              {props.environments.map((environment) => (
                <SimlockTokenField
                  key={environment.environmentId}
                  label={several ? `Agent token · ${environment.label}` : "Agent token"}
                  token={tokens.get(environment.environmentId) ?? { kind: "cleared" }}
                  hasSaved={savedToken(environment)}
                  busy={props.busy}
                  onChange={(token) =>
                    setTokens((current) => new Map(current).set(environment.environmentId, token))
                  }
                />
              ))}
              <p className="text-xs text-muted-foreground">
                Leases, drives, and streams devices. Create one{several ? " per environment" : ""}{" "}
                with <code>simlock --gateway token create --role agent</code>.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {limit("maxLeases", "Devices at once", 1, 20)}
              {limit("maxLeaseMinutes", "Lease minutes", 5, 240)}
            </div>
            <p className="text-xs text-muted-foreground">
              A lease ends after the lease minutes even while in use.
              {props.isNew ? null : " Saving restarts this host, which releases its devices."}
            </p>
            {problem === null || !draft.gatewayUrl ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy || problem !== null}>
              {props.busy ? <Spinner size="xs" /> : null} Save host
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SimlockTokenField(props: {
  label: ReactNode;
  token: SimlockTokenEntry;
  hasSaved: boolean;
  busy: boolean;
  onChange: (token: SimlockTokenEntry) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block">
        {props.label}
      </label>
      <div className="flex items-center gap-2">
        <SecretInput
          id={id}
          className="min-w-0 flex-1"
          configured={props.token.kind === "saved"}
          value={props.token.kind === "new" ? props.token.value : ""}
          disabled={props.busy}
          onChange={(event) => {
            const value = event.target.value;
            // Emptying the field is not clearing the saved token; the Clear
            // button is, so a saved token comes back here.
            props.onChange(
              value
                ? { kind: "new", value }
                : props.hasSaved
                  ? { kind: "saved" }
                  : { kind: "cleared" },
            );
          }}
        />
        {props.token.kind !== "cleared" ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-destructive"
            aria-label="Clear agent token"
            disabled={props.busy}
            onClick={() => props.onChange({ kind: "cleared" })}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

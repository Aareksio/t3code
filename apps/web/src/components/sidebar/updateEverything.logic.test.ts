import { EnvironmentId, type ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  channelSwitchBlockReason,
  collectChannelSwitchTargets,
  collectRestartingMachines,
  collectServerUpdateTargets,
  describeUpdateCapsule,
  describeUpdateEverything,
  runUpdateEverything,
  type UpdateEverythingMachine,
} from "./updateEverything.logic";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed"
            ? { desktopAppUpdate: true, desktopAppChannelSwitch: true }
            : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "on the nightly channel"],
      ["offline", "not connected"],
      ["never-connected", "not connected"],
      ["no-scope", "no permission"],
      ["busy", "already updating"],
      ["manual", "needs a manual update"],
    ]);
  });
});

describe("collectChannelSwitchTargets", () => {
  const NIGHTLY = "0.1.4-nightly.20261027.3796";
  const OLD_NIGHTLY = "0.1.3-nightly.20261001.3500";
  const NEWER_NIGHTLY = "0.1.4-nightly.20261020.3700";
  const migrations: Record<string, number> = {
    [NIGHTLY]: 72,
    [NEWER_NIGHTLY]: 69,
    [OLD_NIGHTLY]: 69,
    "0.1.3": 69,
  };
  const migrationOf = (version: string) => migrations[version];
  const onMac = (base: UpdateEverythingMachine): UpdateEverythingMachine => ({
    ...base,
    serverConfig: {
      ...base.serverConfig!,
      environment: {
        ...base.serverConfig!.environment,
        platform: { os: "darwin", arch: "arm64" },
      },
    },
  });

  it("moves nightly hosts to stable only when stable knows their database", () => {
    const stable = { channel: "latest" as const, version: "0.1.3", databaseMigration: 69 };
    const { targets, skipped } = collectChannelSwitchTargets(
      [
        machine("this-app", NIGHTLY, "desktop-managed", { hostedByThisApp: true }),
        machine("old-service", OLD_NIGHTLY, "boot-service"),
        // Service launchers refuse older versions, even when the database allows it.
        machine("newer-service", NEWER_NIGHTLY, "boot-service"),
        machine("linux-desktop", OLD_NIGHTLY, "desktop-managed"),
        machine("new-service", NIGHTLY, "boot-service"),
        machine("unknown-service", "0.1.2-nightly.20260901.3000", "boot-service"),
        onMac(machine("mac-desktop", OLD_NIGHTLY, "desktop-managed")),
        machine("preview", "0.1.3-preview.20261026.3702", "boot-service"),
        machine("stable", "0.1.3", "boot-service"),
        // Already on Stable, but its saved track may still say Nightly.
        machine("stable-desktop", "0.1.2", "desktop-managed"),
      ],
      stable,
      migrationOf,
    );

    expect(targets.map((target) => [target.serverLabel, target.channel])).toEqual([
      ["old-service", undefined],
      ["linux-desktop", "latest"],
      ["stable-desktop", "latest"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["newer-service", "run `t3 update --channel stable --allow-downgrade` there"],
      [
        "new-service",
        "its database has changes 0.1.3 does not support yet; stay on Nightly until Stable has them",
      ],
      ["unknown-service", "its release predates database checks; update it on Nightly first"],
      ["mac-desktop", "switch the Mac app on that Mac"],
      ["preview", "runs a preview build"],
    ]);
  });

  it("moves stable hosts to nightly without a database check", () => {
    const nightly = { channel: "nightly" as const, version: NIGHTLY, databaseMigration: undefined };
    const { targets, skipped } = collectChannelSwitchTargets(
      [
        machine("service", "0.1.2", "boot-service"),
        machine("old-desktop", "0.1.2", "desktop-managed", {
          serverConfig: {
            ...machine("old-desktop", "0.1.2", "desktop-managed").serverConfig!,
            environment: {
              ...machine("old-desktop", "0.1.2", "desktop-managed").serverConfig!.environment,
              capabilities: { repositoryIdentity: true, serverSelfUpdate: "desktop-managed" },
            },
          },
        }),
        machine("current", NIGHTLY, "boot-service"),
      ],
      nightly,
      () => undefined,
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", NIGHTLY],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["old-desktop", "needs a newer desktop app"],
    ]);
    expect(channelSwitchBlockReason("0.1.2", nightly, undefined)).toBeNull();
  });
});

describe("collectRestartingMachines", () => {
  it("lists updated servers, and this app's servers only when it installs", () => {
    const withContinuation = (
      id: string,
      overrides: Partial<UpdateEverythingMachine> = {},
      enabled = false,
    ) => {
      const base = machine(id, "0.0.40", "boot-service", overrides);
      return {
        ...base,
        serverConfig: {
          environment: base.serverConfig!.environment,
          settings: { continueThreadsAfterServerUpdate: enabled },
        },
      };
    };
    const machines = [
      withContinuation("this-app", { hostedByThisApp: true }, true),
      withContinuation("alvin", {}, true),
      withContinuation("opted-out", {}, false),
      machine("old", "0.0.40", "boot-service"),
      withContinuation("providers-only"),
    ];
    const servers = ["alvin", "opted-out", "old"].map((id) => ({
      environmentId: EnvironmentId.make(id),
    }));

    expect(collectRestartingMachines(machines, servers, true)).toEqual([
      { environmentId: "this-app", continuesThreads: true },
      { environmentId: "alvin", continuesThreads: true },
      { environmentId: "opted-out", continuesThreads: false },
      { environmentId: "old", continuesThreads: false },
    ]);
    expect(
      collectRestartingMachines(machines, servers, false).map((entry) => entry.environmentId),
    ).toEqual(["alvin", "opted-out", "old"]);
  });
});

describe("runUpdateEverything", () => {
  it("still updates remote machines when the local download fails", async () => {
    const calls: string[] = [];
    const result = await runUpdateEverything({
      downloadLocal: async () => false,
      updateProviders: async () => {
        calls.push("providers");
      },
      updateServers: async () => {
        calls.push("servers");
      },
    });

    expect(calls).toEqual(["providers", "servers"]);
    expect(result.localReady).toBe(false);
  });
});

describe("describeUpdateEverything", () => {
  it("gives each machine one row with its T3 Code and provider updates", () => {
    const id = EnvironmentId.make;
    const { rows } = describeUpdateEverything({
      localVersion: "1.1.0",
      localMachines: [
        { environmentId: id("local"), label: "Mainbook" },
        { environmentId: id("wsl"), label: "Mainbook WSL" },
      ],
      servers: [
        {
          environmentId: id("npm"),
          serverLabel: "bb-1",
          selfUpdate: "respawn",
          targetVersion: "1.1.0",
        },
      ],
      providerMachines: [
        { environmentId: id("npm"), label: "bb-1", providers: ["Codex", "Claude"] },
        { environmentId: id("local"), label: "Mainbook", providers: ["Codex"] },
        { environmentId: id("manual"), label: "alvin", providers: ["Claude"] },
      ],
      skipped: [
        { environmentId: id("manual"), label: "alvin", reason: "needs a manual update" },
        { environmentId: id("offline"), label: "TheoRoom", reason: "not connected" },
      ],
    });

    expect(
      rows.map(({ label, app, skipped, providers }) => [label, app, skipped, providers]),
    ).toEqual([
      ["Mainbook", "this-app", null, ["Codex"]],
      ["Mainbook WSL", "this-app", null, []],
      ["bb-1", "server", null, ["Codex", "Claude"]],
      ["alvin", null, "needs a manual update", ["Claude"]],
      ["TheoRoom", null, "not connected", []],
    ]);
  });
});

describe("describeUpdateCapsule", () => {
  it("sends failed track switches back through the planner instead of retrying their target", () => {
    const failed = {
      machine: {
        environmentId: EnvironmentId.make("remote"),
        label: "remote",
        updatesProviders: false,
        server: {
          environmentId: EnvironmentId.make("remote"),
          serverLabel: "remote",
          selfUpdate: "boot-service" as const,
          targetVersion: "0.1.3",
        },
        handedOffVersion: null,
        startedAt: 0,
        result: "failed" as const,
        failure: "offline",
        providerFailure: null,
      },
      status: "failed" as const,
    };
    const run = { localVersion: null, phase: "servers" as const, restartAt: null, machines: [] };

    expect(describeUpdateCapsule(run, [failed], null, 0).action).toBe("retry");
    expect(describeUpdateCapsule({ ...run, trackSwitch: true }, [failed], null, 0).action).toBe(
      "dismiss",
    );
  });
});

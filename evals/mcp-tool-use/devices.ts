/**
 * T3's device tools over a case's world. McpHttpServer's device toolkit runs T3's handlers on its
 * DeviceService, whose hosts are fakes holding the world's devices, so every result and error the
 * agent sees is T3's. Launcher files go to a file system that keeps nothing.
 */
import {
  DeviceError,
  type DeviceHostId,
  DeviceOperationError,
  type DevicePlatform,
  type DeviceSummary,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the eval calls the device tools McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../apps/server/src/config.ts";
import * as AgentDeviceShim from "../../apps/server/src/device/AgentDeviceShim.ts";
import { agentDeviceConfigPath } from "../../apps/server/src/device/AgentDeviceTarget.ts";
import type * as DeviceHost from "../../apps/server/src/device/DeviceHost.ts";
import * as DeviceService from "../../apps/server/src/device/DeviceService.ts";
import * as McpHttpServer from "../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import * as ProjectService from "../../apps/server/src/project/ProjectService.ts";
import { ServerSettingsService } from "../../apps/server/src/serverSettings.ts";

export interface DeviceWorld {
  readonly devices: ReadonlyArray<DeviceSummary>;
  /** Labels of the SSH device hosts, by id. The local host always exists. */
  readonly deviceHosts?: Readonly<Record<string, string>> | undefined;
}

/** One sample's device tools, answered by T3. */
export interface DeviceTools {
  /** Runs one call as T3 does. A `failure` is raised in T3's DeviceService during the call. */
  readonly call: (
    name: string,
    input: unknown,
    failure?: DeviceError,
  ) => Effect.Effect<{ readonly text: string; readonly isError: boolean }>;
  /** The `agent-device` commands `device_open` returned, in order. */
  readonly launchers: ReadonlyArray<string>;
}

export const isDeviceTool = (name: string) => Object.hasOwn(DeviceToolkit.tools, name);

const decodeDeviceError = Schema.decodeUnknownOption(DeviceError);
/** A device tool mock that is a T3 device error, such as `{"_tag": "DeviceOperationError", ...}`. */
export const deviceFailure = (mock: unknown) => Option.getOrUndefined(decodeDeviceError(mock));

const Injected = Context.Reference<DeviceError | undefined>(
  "@t3tools/evals/mcp-tool-use/devices/Injected",
  { defaultValue: () => undefined },
);
const failing = <A, R>(effect: Effect.Effect<A, DeviceError, R>) =>
  Effect.flatMap(Injected, (failure) => (failure === undefined ? effect : Effect.fail(failure)));

// The hosts' own output, which T3 passes on. Launcher scripts embed these paths, never shown.
const NODE = "/usr/bin/node";
const HUB = "http://127.0.0.1:47613";
const PLATFORM_NAMES = { ios: "iOS Simulators", android: "Android Emulators" } as const;
/** T3 reads only a capture's PNG header; replay has no screens to send. */
const capture = (platform: DevicePlatform) => {
  const png = new Uint8Array(24);
  const view = new DataView(png.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, platform === "ios" ? 1206 : 1080);
  view.setUint32(20, platform === "ios" ? 2622 : 2400);
  return png;
};

const fakeHost = (
  world: DeviceWorld,
  id: DeviceHostId,
  label: string,
  agentEntry: string,
): DeviceHost.DeviceHost["Service"] => {
  const devices = world.devices.filter((device) => device.hostId === id);
  const availability = (platform: DevicePlatform) =>
    devices.some((device) => device.platform === platform)
      ? { platform, available: true }
      : { platform, available: false, reason: `${label} has no ${PLATFORM_NAMES[platform]}.` };
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: NODE,
    hub: { origin: HUB },
    devices: {
      list: Effect.succeed({
        devices: devices.map(({ hostId: _hostId, ...device }) => device),
        detail: undefined,
      }),
      boot: (device) => Effect.succeed(device.id),
      attach: () => Effect.void,
      shutdown: () => Effect.void,
      screenshot: (device) => Effect.succeed(capture(device.platform)),
    },
    // T3 checks an Android emulator's host for ffmpeg's H.264 encoder before streaming it.
    run: () => Effect.succeed({ stdout: " V....D libx264 H.264\n", stderr: "", code: 0 }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const agentDevice = {
    baseUrl: `${HUB}/api/device-hub/agent/${id}`,
    token: id,
    entryPath: agentEntry,
  };
  return {
    id,
    label,
    summary: Effect.sync(() => ({
      id,
      label,
      kind: id === LOCAL_DEVICE_HOST_ID ? ("local" as const) : ("ssh" as const),
      platforms: [availability("ios"), availability("android")],
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
    platformAvailability: (platform) => Effect.sync(() => availability(platform)),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.succeed({ ...ready, agentDevice }),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
};

// Refs before and after T3 binds a launcher to each session run this same code. Optional
// exports detect the newer API; makeWithHosts ignores a fifth argument it does not take.
type BoundTarget = { readonly session: string; readonly targetArgs: ReadonlyArray<string> };
type Launchers = {
  readonly bind: (input: BoundTarget) => Effect.Effect<string, DeviceError>;
  readonly prune: (live: ReadonlySet<string>) => Effect.Effect<void>;
};
const launcherApi: {
  readonly ensureAgentDeviceShim: typeof AgentDeviceShim.ensureAgentDeviceShim;
  readonly bindAgentDeviceLauncher?: (
    input: Parameters<typeof AgentDeviceShim.ensureAgentDeviceShim>[0] & BoundTarget,
  ) => ReturnType<typeof AgentDeviceShim.ensureAgentDeviceShim>;
  readonly pruneAgentDeviceLaunchers?: (input: {
    readonly stateDir: string;
    readonly live: ReadonlySet<string>;
  }) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
} = AgentDeviceShim;
type MakeWithHosts = typeof DeviceService.makeWithHosts;
const makeWithHosts: (
  hosts: Parameters<MakeWithHosts>[0],
  testHost: Parameters<MakeWithHosts>[1],
  configureAgent: Parameters<MakeWithHosts>[2],
  installTool: Parameters<MakeWithHosts>[3],
  launchers?: Launchers,
) => ReturnType<MakeWithHosts> = DeviceService.makeWithHosts;

/** T3's device tools for one sample. `cwd` names the home that T3's state lives under. */
export const makeDeviceTools = Effect.fn("evaluateMcpToolUse.makeDeviceTools")(function* (
  world: DeviceWorld,
  environment: { readonly cwd: string; readonly platform: string },
) {
  const home = /^\/(?:home|Users)\/[^/]+/.exec(environment.cwd)?.[0] ?? "/home/user";
  const config = ServerConfig.layerTest(environment.cwd, `${home}/.t3`);
  const files = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.void,
    chmod: () => Effect.void,
  });
  const devices = Layer.effect(
    DeviceService.DeviceService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const agentEntry = path.join(home, ".t3", "tools", "agent-device", "bin", "agent-device.mjs");
      const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([
        [
          LOCAL_DEVICE_HOST_ID,
          fakeHost(world, LOCAL_DEVICE_HOST_ID, LOCAL_DEVICE_HOST_LABEL, agentEntry),
        ],
      ]);
      for (const device of world.devices) {
        const label = world.deviceHosts?.[device.hostId];
        if (device.hostId === LOCAL_DEVICE_HOST_ID || hosts.has(device.hostId)) continue;
        if (label === undefined) {
          return yield* Effect.die(
            new Error(`world.deviceHosts has no label for ${device.hostId}.`),
          );
        }
        hosts.set(device.hostId, fakeHost(world, device.hostId, label, agentEntry));
      }
      // As DeviceService.make, minus writing the config file the path names.
      const configureAgent = (hostId: DeviceHostId, _endpoint: unknown, deviceId?: string) =>
        agentDeviceConfigPath(stateDir, hostId, path, deviceId).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new DeviceOperationError({
                operation: "configure agent",
                reason: "settings_failed",
                cause,
              }),
          ),
        );
      const withFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const { bindAgentDeviceLauncher: bind, pruneAgentDeviceLaunchers: prune } = launcherApi;
      const launchers: Launchers | undefined =
        bind && prune
          ? {
              bind: (input) =>
                AgentDeviceShim.ensureAgentDeviceShim({ entryPath: agentEntry, stateDir }).pipe(
                  Effect.andThen(bind({ entryPath: agentEntry, stateDir, ...input })),
                  withFiles,
                  Effect.mapError(
                    (cause) =>
                      new DeviceOperationError({
                        operation: "bind agent launcher",
                        reason: "command_failed",
                        cause,
                      }),
                  ),
                ),
              prune: (live) => withFiles(prune({ stateDir, live })),
            }
          : undefined;
      const service = yield* makeWithHosts(hosts, undefined, configureAgent, undefined, launchers);
      return DeviceService.DeviceService.of({
        ...service,
        // Older refs install the CLI through agentCli; makeWithHosts has none to install.
        ...("agentCli" in service ? { agentCli: Effect.succeed(agentEntry) } : {}),
        list: failing(service.list),
        open: (input, context) => failing(service.open(input, context)),
        screenshot: (input) => failing(service.screenshot(input)),
        close: (input) => failing(service.close(input)),
      });
    }),
  );
  const context = yield* Layer.build(
    McpHttpServer.layerDeviceToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(devices),
      Layer.provideMerge(
        Layer.mergeAll(
          liveThreadsLayer,
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          ServerSettingsService.layerTest({
            enableDeviceSupport: true,
            enableAgentDeviceAccess: true,
            deviceOnboardingCompleted: true,
          }),
        ),
      ),
      Layer.provideMerge(config),
      Layer.provideMerge(files),
    ),
  );
  type Entry = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
  // The registry keeps each tool's handler; its public type lists only definitions.
  const tools = Context.get(context, McpServer.McpServer).tools as ReadonlyArray<Entry>;
  // The testkit's live thread runs on the `codex` instance; the caller must match it.
  const scope: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("00000000-0000-4000-8000-0000000000e0"),
    requestNamespace: "mcp-tool-use-eval",
    thread: {
      threadId: ThreadId.make("mcp-tool-use-eval"),
      providerSessionId: "mcp-tool-use-eval",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["device"]),
    issuedAt: 0,
  };
  const request = McpSchema.McpRequestContext.of({
    clientId: 0,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
  });
  const launchers: Array<string> = [];
  const call = Effect.fn("evaluateMcpToolUse.deviceCall")(function* (
    name: string,
    input: unknown,
    failure?: DeviceError,
  ) {
    const entry = tools.find((tool) => tool.tool.name === name);
    if (entry === undefined) return yield* Effect.die(new Error(`T3 has no device tool ${name}.`));
    const result = yield* entry.handle(input).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpRequestContext, request),
      Effect.provideService(HostProcess.ExecutablePath, NODE),
      Effect.provideService(HostProcess.Platform, environment.platform as NodeJS.Platform),
      Effect.provideService(Injected, failure),
      // T3 logs each failed screenshot; the result already says so.
      Effect.provideService(References.MinimumLogLevel, "Error"),
      // An MCP client shows a protocol error, such as bad parameters, as the tool's error.
      Effect.catch((error) =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            isError: true,
            content: [{ type: "text", text: error.message }],
          }),
        ),
      ),
    );
    if (!("content" in result)) return yield* Effect.die(new Error(`${name} asked for input.`));
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    // McpServer turns a defect into this text; here a defect is a bug in the eval's world.
    if (text === "Tool execution failed due to an internal server error.") {
      return yield* Effect.die(new Error(`${name} hit a defect in T3 or the eval's world.`));
    }
    const opened = result.structuredContent;
    if (name === "device_open" && !result.isError && isOpened(opened)) {
      launchers.push(opened.agentDevice.command);
    }
    return { text, isError: result.isError === true };
  });
  return { call, launchers } satisfies DeviceTools;
});

const isOpened = Schema.is(
  Schema.Struct({ agentDevice: Schema.Struct({ command: Schema.String }) }),
);

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AGENT_DEVICE_SHELL, deviceFailure, launcherHelp, makeDeviceTools } from "./devices.ts";
import {
  buildBase,
  buildMessages,
  makeSample,
  McpToolUseCase,
  shellRequest,
  t3SubagentContext,
  t3SystemAppend,
  withDevices,
} from "./run.ts";

const MAC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IPHONE = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const world = {
  devices: [
    {
      hostId: MAC,
      id: IPHONE,
      name: "Acme iPhone",
      platform: "ios",
      version: "iOS 26.0",
      booted: true,
      physical: false,
    },
  ],
  deviceHosts: { [MAC]: "build-mac" },
};
const screenshotFailure = {
  _tag: "DeviceOperationError",
  operation: "screenshot",
  reason: "request_failed",
  cause: null,
};
const decodeCase = Schema.decodeUnknownSync(McpToolUseCase);
const deviceCase = (setup: object) =>
  decodeCase({
    id: "device-case",
    area: "device-manager",
    kind: "guard",
    pattern: "device",
    experience: "A device case.",
    setup: { role: "top", world, ...setup },
    prompt: "Show a fresh screenshot of the iPhone on build-mac.",
    expect: {},
  });
const capture = JSON.parse(
  NodeZlib.gunzipSync(
    NodeFS.readFileSync(new URL("./templates/claude.json.gz", import.meta.url)),
  ).toString(),
).request.provider_native;
const model = "claude-opus-5-5";
const base = buildBase(capture, { model, keepUserInstructions: false });
const json = (text: string) => JSON.parse(text);

it.effect("answers device calls with T3's handlers over the case's world", () =>
  Effect.gen(function* () {
    const { devices, deviceHosts } = deviceCase({}).setup.world ?? {};
    const tools = yield* makeDeviceTools({ devices: devices ?? [], deviceHosts }, base.environment);
    const listed = json((yield* tools.call("device_list", {})).text);
    assert.deepEqual(listed.devices, world.devices);
    assert.deepEqual(
      listed.hosts.map((host: { label: string }) => host.label),
      ["This machine", "build-mac"],
    );
    const opened = json((yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE })).text);
    const { command } = opened.agentDevice;
    assert.match(command, /^\/home\/user\/\.t3\/userdata\/device\/.+\/agent-device$/);
    assert.include(opened.quickStart, command);
    assert.deepEqual(tools.launchers, [command]);
    // The image never reaches the model; T3's text result has the rest.
    assert.deepEqual(json((yield* tools.call("device_screenshot", {})).text).screenshot, {
      mimeType: "image/png",
      width: 1206,
      height: 2622,
    });
    const failed = yield* tools.call("device_screenshot", {}, deviceFailure(screenshotFailure));
    assert.isTrue(failed.isError);
    assert.include(failed.text, "screenshot failed");
    const elsewhere = yield* tools.call("device_open", { hostId: "local", deviceId: IPHONE });
    assert.isTrue(elsewhere.isError);
    assert.include(elsewhere.text, IPHONE);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("decodes only T3 device errors as injected failures", () => {
  assert.isDefined(deviceFailure(screenshotFailure));
  assert.isUndefined(deviceFailure({ error: "Synthetic hub is unavailable", isError: true }));
  assert.isUndefined(deviceFailure("default"));
});

it.effect("rebuilds prior device results with T3, whose sessions reach the measured turn", () =>
  Effect.gen(function* () {
    const testCase = deviceCase({
      priorTurns: [
        { role: "user", text: "Show me Settings on the iPhone on build-mac." },
        {
          role: "assistant",
          toolCalls: [
            { tool: "device_list", input: {}, result: "default" },
            { tool: "device_open", input: { hostId: MAC, deviceId: IPHONE }, result: "default" },
          ],
        },
      ],
      mocks: { device_screenshot: screenshotFailure },
    });
    const sample = makeSample(testCase, base);
    assert.throws(() => buildMessages(sample), /run withDevices/);
    yield* withDevices(sample);
    const shown = JSON.stringify(buildMessages(sample));
    const [launcher = ""] = sample.devices?.launchers ?? [];
    assert.include(shown, launcher);
    assert.notInclude(shown, `"content":"default"`);
    const tools = sample.devices!;
    assert.isFalse((yield* tools.call("device_screenshot", {})).isError);
    const mock = deviceFailure(testCase.setup.mocks?.device_screenshot);
    assert.isTrue((yield* tools.call("device_screenshot", {}, mock)).isError);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("gives a native subagent T3's SubagentStart context instead of T3's append", () =>
  Effect.gen(function* () {
    const subagentContext = yield* Effect.promise(() => t3SubagentContext(model));
    const native = {
      ...buildBase(capture, { model, keepUserInstructions: false, nativeSubagent: true }),
      subagentContext,
    };
    const system = (blocks: typeof base.system) =>
      blocks.map((block) => String(block.text)).join("");
    assert.include(system(base.system), t3SystemAppend(model));
    assert.notInclude(system(native.system), t3SystemAppend(model));
    const testCase = deviceCase({ role: "native-subagent" });
    const shown = (sample: typeof native) =>
      buildMessages(makeSample(testCase, sample))[0]?.content.map((block) => String(block.text));
    const reminders = shown(native)?.join("\n") ?? "";
    // A ref without T3's hook gives the subagent nothing.
    assert.equal(
      reminders.includes("SubagentStart hook additional context"),
      subagentContext !== "",
    );
    assert.include(reminders, subagentContext);
    // Claude Code 2.1.310 records the hook's context after the task, and sends it that way.
    const blocks = shown({ ...native, subagentContext: "## T3 Code devices" }) ?? [];
    assert.equal(blocks.at(-2), testCase.prompt);
    assert.equal(
      blocks.at(-1),
      "<system-reminder>\nSubagentStart hook additional context: ## T3 Code devices\n</system-reminder>",
    );
  }),
);

it.effect("tells the shell simulator the launchers T3 returned and agent-device's real CLI", () =>
  Effect.gen(function* () {
    const sample = makeSample(deviceCase({}), base);
    yield* withDevices(sample);
    const call = { tool: "Bash", input: { command: "ls /tmp" } };
    const told = (request: ReturnType<typeof shellRequest>) => JSON.stringify(request.messages);
    assert.notInclude(told(shellRequest(sample, call, "claude-haiku-5-5")), "launchers T3's");
    const opened = yield* sample.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE });
    const { command } = json(opened.text).agentDevice;
    const request = shellRequest(sample, call, "claude-haiku-5-5");
    assert.include(told(request), `agent-device launchers T3's device_open returned: ${command}`);
    // agent-device's own syntax: a positional recording path, and `record stop` with no flag.
    assert.include(request.system, AGENT_DEVICE_SHELL);
    assert.include(
      request.system,
      "agent-device record start [path] [--scope <app|device|system>]",
    );
    assert.include(request.system, "| record stop |");
    assert.include(request.system, "Unknown flag: --stop. Did you mean --scope?");
    // A case without devices keeps the shell prompt every other case has.
    const plain = makeSample(deviceCase({ world: {} }), base);
    assert.notInclude(shellRequest(plain, call, "claude-haiku-5-5").system, "agent-device");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("prints agent-device's own help for a lone help command on a returned launcher", () => {
  const help = (topic: string) =>
    AGENT_DEVICE_SHELL.split(`$ agent-device help${topic ? ` ${topic}` : ""}\n`)[1]
      ?.split("\n$ agent-device help")[0]
      ?.trimEnd();
  // Commands from the paired runs. The simulator once answered the first with a placeholder.
  const launcher = "/home/user/.t3/userdata/device/bin/agent-device";
  const target = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/303617b9730210ef3c86c52d.json --session t3-4c43aa31e607633b85e9ff2f`;
  const asked = (command: string) => launcherHelp([launcher], command);
  assert.match(help("") ?? "", /^agent-device <command> \[args\] \[--json\]\n/);
  assert.equal(asked(`${launcher} help ${target}`), help(""));
  assert.equal(asked(`${launcher} record --help ${target}`), help("record"));
  assert.equal(asked(`${launcher} help open ${target}`), help("open"));
  assert.equal(asked(`${launcher} --help 2>&1`), help(""));
  assert.equal(asked(`${launcher} help settings --session=t3-1`), help("settings"));
  // Anything else stays with the simulator: other topics, pipes, aliases, other commands.
  assert.isUndefined(asked(`${launcher} metro --help ${target}`));
  assert.isUndefined(asked(`${launcher} help record 2>&1 | head -40`));
  assert.isUndefined(asked(`AD=${launcher}; $AD help record`));
  assert.isUndefined(asked(`${launcher} snapshot -i ${target}`));
  assert.isUndefined(asked(`/usr/local/bin/agent-device help`));
});

it("pins agent-device's help to the version T3 installs", () => {
  const versions = JSON.parse(
    NodeFS.readFileSync(
      new URL("../../apps/server/src/device/deviceToolVersions.json", import.meta.url),
      "utf8",
    ),
  );
  assert.include(AGENT_DEVICE_SHELL, `agent-device ${versions["agent-device"]} prints this help`);
});

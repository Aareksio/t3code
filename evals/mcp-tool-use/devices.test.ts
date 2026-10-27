// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { deviceFailure, makeDeviceTools } from "./devices.ts";
import {
  buildBase,
  buildMessages,
  makeSample,
  McpToolUseCase,
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
    const [first] = buildMessages(makeSample(deviceCase({ role: "native-subagent" }), native));
    const reminders = first?.content.map((block) => String(block.text)).join("\n") ?? "";
    // A ref without T3's hook gives the subagent nothing.
    assert.equal(
      reminders.includes("SubagentStart hook additional context"),
      subagentContext !== "",
    );
    assert.include(reminders, subagentContext);
  }),
);

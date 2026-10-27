// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AGENT_DEVICE_SHELL,
  agentDeviceSessionError,
  agentDeviceSessions,
  deviceFailure,
  type LauncherTarget,
  launcherHelp,
  makeDeviceTools,
  type ShellCall,
} from "./devices.ts";
import {
  buildBase,
  buildMessages,
  cannedOutput,
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

it.effect("lists the boot state T3 left a device in", () =>
  Effect.gen(function* () {
    const { devices, deviceHosts } = deviceCase({}).setup.world ?? {};
    const stopped = (devices ?? []).map((device) => ({ ...device, booted: false }));
    const tools = yield* makeDeviceTools({ devices: stopped, deviceHosts }, base.environment);
    const before = json((yield* tools.call("device_list", {})).text);
    assert.isFalse(before.devices.find((d: { id: string }) => d.id === IPHONE).booted);
    yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE });
    const after = json((yield* tools.call("device_list", {})).text);
    assert.isTrue(after.devices.find((d: { id: string }) => d.id === IPHONE).booted);
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

// agent-device 0.21.31's errors as a real Mac printed them (stderr, exit status 1).
const NO_SESSION =
  "Error (SESSION_NOT_FOUND): No active session. Run open first.\nHint: Run open first or pass an explicit device selector.";
const APP_RECORDING_BEFORE_OPEN =
  "Error (INVALID_ARGS): record start with app scope and an explicit session requires an active app session; run open <app> first, or use --scope device to record the full screen\nHint: Check command arguments and run --help for usage examples.";
const APP_RECORDING_WITHOUT_APP =
  "Error (UNKNOWN): App-scoped recording requires an active app session; open the app under test before recording.\nHint: Unexpected internal error. Retry with --debug and report the diagnostics log if it persists.";

it.effect("answers the returned launcher as agent-device does before and after open", () =>
  Effect.gen(function* () {
    const { devices = [], deviceHosts } = deviceCase({}).setup.world ?? {};
    const tools = yield* makeDeviceTools({ devices, deviceHosts }, base.environment);
    const opened = json((yield* tools.call("device_open", { hostId: MAC, deviceId: IPHONE })).text);
    const { command, targetArgs, session: bound } = opened.agentDevice;
    // This ref's launcher: a bound one names its session; the shared one takes device_open's flags.
    const session: string = bound ?? targetArgs[targetArgs.indexOf("--session") + 1];
    const line = (args: string) =>
      bound === undefined ? `${command} ${args} ${targetArgs.join(" ")}` : `${command} ${args}`;
    const history: Array<ShellCall> = [];
    const answer = (args: string) => tools.sessionError(history, line(args));
    const ran = (args: string, output: string) =>
      history.push({ tool: "Bash", input: { command: line(args) }, output });

    const shot = answer("screenshot /tmp/shot.png") ?? "";
    assert.isTrue(shot.startsWith(`Exit code 1\n${NO_SESSION}\nDiagnostic ID: `));
    assert.match(
      shot,
      new RegExp(
        `\\nDiagnostics Log: /home/user/\\.agent-device/remote-diagnostics/${session}/requests/[\\da-f]{16}\\.ndjson$`,
      ),
    );
    for (const args of ["press @e3 --settle", 'fill @e5 "hello world"', "scroll down", "home"]) {
      assert.include(answer(args), NO_SESSION, args);
    }
    assert.include(answer("record start /tmp/run.mp4"), APP_RECORDING_BEFORE_OPEN);
    // With the device selector both refs pass, these run without a session.
    for (const args of [
      "open",
      "devices",
      "apps",
      "snapshot -i",
      "settings appearance dark",
      "alert accept",
      "install com.acme.app /tmp/Acme.app",
      "record start --scope device /tmp/run.mp4",
    ]) {
      assert.isUndefined(answer(args), args);
    }
    // Unknown flags, JSON output and compound commands stay with the simulator.
    assert.isUndefined(answer("screenshot --bogus /tmp/shot.png"));
    assert.isUndefined(answer("screenshot --json /tmp/shot.png"));
    assert.isUndefined(tools.sessionError(history, `${line("screenshot /tmp/a.png")} && echo ok`));
    assert.deepEqual([...tools.sessions(history)], [[session, undefined]]);

    ran("open com.acme.missing", "Exit code 1\nError (APP_NOT_INSTALLED): App not installed");
    assert.include(answer("screenshot /tmp/shot.png"), NO_SESSION);
    ran("open", `Opened: ${session}`);
    assert.isUndefined(answer("screenshot /tmp/shot.png"));
    assert.isUndefined(answer("press @e3"));
    assert.include(answer("record start /tmp/run.mp4"), APP_RECORDING_WITHOUT_APP);
    assert.isUndefined(answer("record start --scope device /tmp/run.mp4"));
    ran("open com.acme.app", "Opened: com.acme.app");
    assert.isUndefined(answer("record start /tmp/run.mp4"));
    assert.deepEqual([...tools.sessions(history)], [[session, { app: true }]]);
    ran("close", "Closed");
    assert.include(
      tools.sessionError(history, `${line("screenshot /tmp/a.png")} 2>&1`),
      NO_SESSION,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const shared = (session: string): LauncherTarget => ({
  command: "/home/user/.t3/userdata/device/bin/agent-device",
  session,
  bound: false,
  deviceId: IPHONE,
  iosSimulator: true,
});
const boundTarget: LauncherTarget = {
  command: "/home/user/.t3/userdata/device/targets/t3-bound/agent-device",
  session: "t3-bound",
  bound: true,
  deviceId: IPHONE,
  iosSimulator: true,
};
const bash = (command: string, output = "OK"): ShellCall => ({
  tool: "Bash",
  input: { command },
  output,
});
const errorCode = (
  targets: ReadonlyArray<LauncherTarget>,
  history: ReadonlyArray<ShellCall>,
  command: string,
) => agentDeviceSessionError(targets, agentDeviceSessions(targets, {}, history), command)?.code;

it("names the session on either ref: the bound launcher's own, or the shared one's --session", () => {
  const flags = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/x.json`;
  const sharedTargets = [shared("t3-a"), shared("t3-b")];
  // The shared launcher answers each session its flags name; without one, its own check (not
  // modelled) refuses before agent-device runs.
  const opened = [bash(`${sharedTargets[0]!.command} open com.acme.app ${flags} --session t3-a`)];
  assert.isUndefined(
    errorCode(
      sharedTargets,
      opened,
      `${sharedTargets[0]!.command} screenshot ${flags} --session t3-a`,
    ),
  );
  assert.equal(
    errorCode(
      sharedTargets,
      opened,
      `${sharedTargets[0]!.command} screenshot ${flags} --session=t3-b`,
    ),
    "SESSION_NOT_FOUND",
  );
  assert.isUndefined(errorCode(sharedTargets, [], `${sharedTargets[0]!.command} screenshot`));
  // The bound launcher needs no flags, and an explicit --session still wins.
  assert.equal(
    errorCode([boundTarget], [], `${boundTarget.command} screenshot`),
    "SESSION_NOT_FOUND",
  );
  assert.equal(errorCode([boundTarget], [], `${boundTarget.command} record start`), "INVALID_ARGS");
  const boundOpen = [bash(`${boundTarget.command} open`)];
  assert.isUndefined(errorCode([boundTarget], boundOpen, `${boundTarget.command} screenshot`));
  assert.equal(
    errorCode([boundTarget], boundOpen, `${boundTarget.command} record start /tmp/r.mp4`),
    "UNKNOWN",
  );
  assert.equal(
    errorCode([boundTarget], boundOpen, `${boundTarget.command} screenshot --session other`),
    "SESSION_NOT_FOUND",
  );
  // Without a selector, agent-device's record and close refuse a missing named session with
  // other text; that stays with the simulator.
  assert.isUndefined(
    errorCode(sharedTargets, [], `${sharedTargets[0]!.command} record start --session t3-a`),
  );
});

it("follows the session through aliases, compound calls, snapshots and whole-screen recordings", () => {
  const launcher = boundTarget.command;
  const after = (...history: ReadonlyArray<ShellCall>) =>
    agentDeviceSessions([boundTarget], {}, history).get("t3-bound");
  assert.deepEqual(after(bash(`AD=${launcher}; "$AD" open com.acme.app`)), { app: true });
  // A failed lone open starts nothing; an open in a failed compound call still counts.
  assert.isUndefined(after(bash(`${launcher} open com.acme.app`, "Exit code 1\nError (X): no")));
  assert.deepEqual(
    after(bash(`${launcher} open com.acme.app && ${launcher} press @e9`, "Exit code 1\nboom")),
    { app: true },
  );
  // Dead tails, remote agent-device and help start nothing.
  assert.isUndefined(after(bash(`false && ${launcher} open`, "Exit code 1")));
  assert.isUndefined(after(bash("ssh build-mac agent-device open com.acme.app")));
  assert.isUndefined(after(bash(`${launcher} help open`)));
  // agent-device publishes a session for a sessionless snapshot, without an app.
  assert.deepEqual(after(bash(`${launcher} snapshot -i`)), { app: false });
  // A whole-screen recording holds a session only until it stops.
  const recording = bash(`${launcher} record start --scope device /tmp/r.mp4`);
  assert.deepEqual(after(recording), { app: false, recordingOnly: true });
  assert.isUndefined(errorCode([boundTarget], [recording], `${launcher} screenshot`));
  assert.isUndefined(after(recording, bash(`${launcher} record stop`)));
  assert.equal(
    errorCode(
      [boundTarget],
      [recording, bash(`${launcher} record stop`)],
      `${launcher} screenshot`,
    ),
    "SESSION_NOT_FOUND",
  );
  assert.deepEqual(after(bash(`${launcher} open`), bash(`${launcher} close`)), undefined);
});

it("follows the shared launcher's session through flags held in a variable or an array", () => {
  // Forms Sonnet used with the shared launcher in a live sample.
  const target = shared("t3-a");
  const flags = `--platform ios --udid ${IPHONE} --config /home/user/.t3/userdata/device/hosts/x.json --session t3-a`;
  const after = (history: ShellCall, targets = [target]) =>
    agentDeviceSessions(targets, {}, [history]).get("t3-a");
  const opened = bash(
    `AD=${target.command}; A="${flags}"; $AD open com.acme.app $A 2>&1 | tail -5; sleep 5; $AD snapshot -i $A 2>&1 | head -60`,
    "Opened: com.acme.app",
  );
  assert.deepEqual(after(opened), { app: true });
  const array = bash(`A=(${flags}); ${target.command} snapshot -i "\${A[@]}" 2>&1 | head -60`);
  assert.deepEqual(after(array), { app: false });
  // With two sessions behind the shared launcher, unread flags name neither.
  assert.isUndefined(after(array, [target, shared("t3-b")]));
  // agent-device still sees no session for a plain command after a failed open in a variable.
  const failed = bash(
    `AD=${target.command}; A="${flags}"; $AD open $A`,
    "Exit code 1\nError (X): no",
  );
  assert.equal(
    errorCode([target], [failed], `${target.command} screenshot ${flags}`),
    "SESSION_NOT_FOUND",
  );
});

it.effect("starts sessions the world says prior turns opened, and rejects unknown devices", () =>
  Effect.gen(function* () {
    const testCase = deviceCase({
      world: { ...world, agentDeviceSessions: { [IPHONE]: { app: "com.acme.app" } } },
      priorTurns: [
        { role: "user", text: "Show me Settings on the iPhone on build-mac." },
        {
          role: "assistant",
          toolCalls: [
            { tool: "device_open", input: { hostId: MAC, deviceId: IPHONE }, result: "default" },
          ],
        },
      ],
    });
    const sample = makeSample(testCase, base);
    yield* withDevices(sample);
    const tools = sample.devices!;
    const [launcher = ""] = tools.launchers;
    assert.deepEqual([...tools.sessions(sample.shell).values()], [{ app: true }]);
    const call = { tool: "Bash", input: { command: "ls" } };
    assert.include(
      JSON.stringify(shellRequest(sample, call, "claude-haiku-5-5").messages),
      "is open with an app",
    );
    assert.isUndefined(tools.sessionError(sample.shell, `${launcher} record start /tmp/r.mp4`));
    const { devices = [], deviceHosts } = testCase.setup.world ?? {};
    const unknown = { devices, deviceHosts, agentDeviceSessions: { "not-a-device": {} } };
    const exit = yield* Effect.exit(makeDeviceTools(unknown, base.environment));
    assert.isTrue(exit._tag === "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "answers a shell mock first, then help, then the session error, before the simulator",
  () =>
    Effect.gen(function* () {
      const sample = makeSample(deviceCase({}), base);
      yield* withDevices(sample);
      const opened = yield* sample.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE });
      const { command, targetArgs, session } = json(opened.text).agentDevice;
      const flags = session === undefined ? ` ${targetArgs.join(" ")}` : "";
      const told = () =>
        JSON.stringify(
          shellRequest(sample, { tool: "Bash", input: {} }, "claude-haiku-5-5").messages,
        );
      assert.include(told(), "has not started; no open or snapshot has run in it");
      assert.include(cannedOutput(sample, `${command} screenshot /tmp/a.png${flags}`), NO_SESSION);
      assert.match(cannedOutput(sample, `${command} help record`) ?? "", /^Usage:/);
      assert.isUndefined(cannedOutput(sample, `${command} open com.acme.app${flags}`));
      const outage = makeSample(
        deviceCase({
          shellMocks: [
            { match: "\\bagent-device\\b", output: "Exit code 1\nError (COMMAND_FAILED): down" },
          ],
        }),
        base,
      );
      yield* withDevices(outage);
      yield* outage.devices!.call("device_open", { hostId: MAC, deviceId: IPHONE });
      assert.include(cannedOutput(outage, `${command} screenshot /tmp/a.png${flags}`), "down");
      sample.shell.push({
        tool: "Bash",
        input: { command: `${command} open com.acme.app${flags}` },
        output: "Opened: com.acme.app",
      });
      assert.isUndefined(cannedOutput(sample, `${command} screenshot /tmp/a.png${flags}`));
      assert.include(told(), "is open with an app");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, expect, it } from "@effect/vitest";

import {
  buildBase,
  buildMessages,
  failedEarly,
  executeCodex,
  gradeSample,
  makeSample,
  ranCalls,
  McpToolUseCase,
  mockOutput,
  normalizeToolInput,
  normalizeToolName,
  type SampleRun,
  shellOutput,
  shellRequest,
  t3SystemAppend,
  t3SubagentContext,
  withDevices,
} from "./run.ts";
import { briefRoute, gradeDevice } from "./device-grading.ts";
import { taskPrompt } from "../../apps/server/src/mcp/OrchestratorMcpService.ts";

it("grades Codex shell and subagent calls with the shared rules", () => {
  const calls = [
    { name: "exec_command", input: { cmd: "sleep 60" } },
    { name: "collaboration.spawn_agent", input: { task: "review" } },
    { name: "mcp__t3_code__delegate_task", input: {} },
  ].map(({ name, input }) => ({
    step: 0,
    tool: normalizeToolName(name),
    input: normalizeToolInput(name, input),
  }));
  assert.deepEqual(
    calls.map((c) => c.tool),
    ["Bash", "Agent", "delegate_task"],
  );
  assert.deepEqual(
    failed(
      {
        calls: [{ tool: "Bash", args: { command: "~sleep" } }],
        notCalls: ["Agent"],
        shellMustNot: ["sleep"],
      },
      { calls, text: "", stopReason: "end_turn" },
    ),
    ["notCalls Agent", "shellMustNot /sleep/"],
  );
});

it("accepts any tool listed as an alternative", () => {
  const expect = { calls: [{ tool: "link_pull_request|watch_pull_request" }] };
  const run = (tool: string): SampleRun => ({
    calls: [{ step: 0, tool, input: {} }],
    text: "",
    stopReason: "end_turn",
  });
  assert.deepEqual(failed(expect, run("watch_pull_request")), []);
  assert.deepEqual(failed(expect, run("list_thread_pull_requests")), [
    "calls link_pull_request|watch_pull_request",
  ]);
});

it("runs code-mode calls without exposing host capabilities, including after await", async () => {
  const catalog = [{ name: "mock", description: "mock" }];
  const result = await executeCodex(
    "text((await tools.mock({n: 2})).n); text([typeof process, typeof require, typeof fetch]);",
    catalog,
    async (_, input) => input,
  );
  assert.include(result, "2\n");
  assert.include(result, '["undefined","undefined","undefined"]');
  assert.include(
    await executeCodex('text.constructor("return process")()', catalog, async () => null),
    "Code generation from strings disallowed",
  );
  await expect(
    executeCodex("await tools.mock({}); while (true) {}", catalog, async () => null),
  ).rejects.toThrow("Script execution timed out");
});

it("answers a code-mode call the cell does not await", async () => {
  const answered: Array<unknown> = [];
  const catalog = [{ name: "mock", description: "mock" }];
  await executeCodex('tools.mock({n: 1}); text("done");', catalog, async (_, input) => {
    answered.push(input);
    return null;
  });
  assert.deepEqual(answered, [{ n: 1 }]);
});

const failed = (expect: Parameters<typeof gradeSample>[0], run: SampleRun) =>
  gradeSample(expect, run)
    .filter((check) => !check.pass)
    .map((check) => check.check);

it("passes a good run and names every rule a bad run breaks", () => {
  const expect = {
    calls: [{ tool: "delegate_task", args: { task: "~FINDING", "target.options": "~max" } }],
    callsMustNot: [{ tool: "delegate_task", args: { runtimeMode: "approval-required" } }],
    notCalls: ["t3_thread_send"],
    order: ["orchestrator_capabilities", "delegate_task"],
    minCalls: { orchestrator_capabilities: 1 },
    maxCalls: { task_status: 0 },
    endsTurnAfter: "delegate_task",
    shellMustNot: ["\\bsleep\\b"],
    textMust: ["t3-thread://v1/"],
    textMustNot: ["Paste .*token"],
    linked: ["~/pull/124"],
  };
  const good: SampleRun = {
    calls: [
      { step: 0, tool: "orchestrator_capabilities", input: {} },
      {
        step: 1,
        tool: "delegate_task",
        input: { task: "Prior findings: ...", target: { options: { reasoningEffort: "max" } } },
      },
    ],
    text: "Started [Review](t3-thread://v1/11111111-1111-4111-8111-111111111111). Do not paste a token.",
    stopReason: "end_turn",
    linked: ["https://github.com/acme/app/pull/124"],
  };
  assert.deepEqual(failed(expect, good), []);

  const bad: SampleRun = {
    calls: [
      {
        step: 0,
        tool: "delegate_task",
        input: { task: "Review again", runtimeMode: "approval-required" },
      },
      { step: 1, tool: "t3_thread_send", input: {} },
      { step: 2, tool: "Monitor", input: { command: "sleep 60" } },
      { step: 3, tool: "task_status", input: { taskId: "task-1" } },
    ],
    text: "Paste your token here.",
    stopReason: "max_steps",
  };
  assert.deepEqual(failed(expect, bad), [
    'calls delegate_task {"task":"~FINDING","target.options":"~max"}',
    'callsMustNot delegate_task {"runtimeMode":"approval-required"}',
    "notCalls t3_thread_send",
    "order orchestrator_capabilities > delegate_task",
    "minCalls orchestrator_capabilities >= 1",
    "maxCalls task_status <= 0",
    "endsTurnAfter delegate_task",
    "shellMustNot /\\bsleep\\b/",
    "textMust /t3-thread://v1//",
    "textMustNot /Paste .*token/",
    "linked ~/pull/124",
  ]);
});

it("bounds numbers and reads target.options in either schema form", () => {
  const expect = {
    calls: [
      { tool: "t3_thread_read", args: { limit: "<=20" } },
      { tool: "delegate_task", args: { "target.options.effort": "max", timeoutMs: ">=60000" } },
    ],
  };
  const run = (limit: unknown, options: unknown, timeoutMs: number): SampleRun => ({
    calls: [
      { step: 0, tool: "t3_thread_read", input: { limit } },
      { step: 0, tool: "delegate_task", input: { target: { options }, timeoutMs } },
    ],
    text: "",
    stopReason: "end_turn",
  });
  assert.deepEqual(failed(expect, run(20, [{ id: "effort", value: "max" }], 60_000)), []);
  assert.deepEqual(failed(expect, run(5, { effort: "max" }, 90_000)), []);
  assert.lengthOf(failed(expect, run(21, [{ id: "effort", value: "high" }], 59_999)), 2);
  assert.lengthOf(failed(expect, run("10", {}, 60_000)), 2);
});

const template = {
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
    { type: "text", text: "You are Claude Code." },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\n# currentDate\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\n# gitStatus\nmain\n</system-reminder>" },
        {
          type: "text",
          text: "<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>",
        },
        { type: "text", text: "The captured prompt." },
      ],
    },
    {
      role: "system",
      content:
        "Main prompt.\n - Primary working directory: /home/alice/app\n\n<runtime_info>old</runtime_info>\n\n## T3 Code orchestration\nold text",
    },
    {
      role: "system",
      content:
        "You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n\nThe following deferred tools are now available via ToolSearch. Load them first:\nMonitor\nmcp__t3-code__retired_tool\n\nAfter the list.",
    },
    { role: "assistant", content: [{ type: "text", text: "A later turn." }] },
  ],
  tools: [
    { name: "mcp__host__term_Bash", input_schema: { type: "object" } },
    { name: "mcp__host__clown_ToolSearch", input_schema: { type: "object" } },
    { name: "mcp__t3-code__retired_tool", input_schema: { type: "object" }, defer_loading: true },
  ],
};

const childCase: McpToolUseCase = {
  id: "child-links-its-pr",
  area: "pull-requests",
  kind: "guard",
  pattern: "delegated child watches PR",
  experience: "A delegated child must link its PR and report back, not watch it.",
  setup: {
    role: "delegated-child",
    delegateRole: "implementation",
    world: { branch: "fix/date-format", files: { "src/date.ts": "export const format = 1;\n" } },
    priorTurns: [
      {
        role: "assistant",
        toolCalls: [{ tool: "Bash", input: { command: "git push" }, result: "pushed" }],
      },
    ],
    shellMocks: [{ match: "^gh pr create", output: "https://github.com/acme/app/pull/124" }],
  },
  prompt: "Push the fix, open a PR against main, and report the PR URL.",
  expect: { calls: [{ tool: "link_pull_request" }], notCalls: ["watch_pull_request"] },
};

it("rebuilds the template from this checkout and sends a child T3's task prompt", () => {
  const base = buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false });
  const system = base.system.map((block) => String(block.text));
  assert.deepEqual(system.slice(0, 2), [
    "You are Claude Code.",
    `Main prompt.\n - Primary working directory: /home/user/app\n\n${t3SystemAppend("claude-sonnet-5-5")}`,
  ]);
  assert.equal(base.environment.cwd, "/home/user/app");
  assert.include(system[2], "model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5.");
  const deferred = system[2]?.split("Load them first:\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
  assert.includeMembers(deferred, ["Monitor", "mcp__t3-code__delegate_task"]);
  assert.notInclude(deferred, "mcp__t3-code__retired_tool");
  // A delegated child is never offered the tools T3 hides from subagents.
  assert.include(deferred, "mcp__t3-code__watch_pull_request");
  const child = buildBase(template, {
    model: "claude-sonnet-5-5",
    keepUserInstructions: false,
    subagent: true,
  });
  assert.notInclude(String(child.system[2]?.text), "mcp__t3-code__watch_pull_request");
  assert.notInclude(
    child.t3.map((tool) => tool.name),
    "mcp__t3-code__unwatch_pull_request",
  );
  const reminders = buildMessages(makeSample(childCase, base))[0]?.content.map((b) => b.text);
  assert.equal(reminders?.[0], "<system-reminder>\n# currentDate\n</system-reminder>");
  assert.include(reminders?.[1], "Current branch: fix/date-format");
  assert.notInclude(reminders?.join(), "Codebase and user instructions");

  const prompt = buildMessages(makeSample(childCase, base)).at(-1)?.content.at(-1);
  assert.equal(prompt?.text, taskPrompt({ task: childCase.prompt, role: "implementation" }));
  assert.notEqual(prompt?.text, childCase.prompt);
});

it("replays earlier capability results with the model under test as the caller", () => {
  const base = buildBase(template, { model: "claude-opus-5-5", keepUserInstructions: false });
  const capabilities = {
    inheritedProviderInstanceId: "claudeAgent",
    inheritedModel: "claude-sonnet-5-5",
  };
  const testCase: McpToolUseCase = {
    ...childCase,
    setup: {
      role: "top",
      priorTurns: [
        {
          role: "assistant",
          toolCalls: [{ tool: "orchestrator_capabilities", input: {}, result: capabilities }],
        },
      ],
    },
  };
  const replayed = buildMessages(makeSample(testCase, base))
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && String(block.content).includes("inherited"));
  assert.include(String(replayed?.content), '"inheritedModel":"claude-opus-5-5"');
});

it("does not record a deferred tool called before it was loaded", () => {
  const base = buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false });
  const sample = makeSample(childCase, base);
  const use = (name: string) => ({ type: "tool_use" as const, id: name, name, input: {} });
  const ran = ranCalls(sample, 0, [
    use("mcp__t3-code__link_pull_request"),
    use("mcp__host__term_Bash"),
  ]);
  assert.deepEqual(
    ran.map((call) => call.tool),
    ["Bash"],
  );
});

it("answers simple mocked commands itself and gives the simulator the sample's history", () => {
  const sample = makeSample(
    childCase,
    buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false }),
  );
  assert.equal(mockOutput(sample, "gh pr create --fill"), "https://github.com/acme/app/pull/124");
  assert.isUndefined(mockOutput(sample, "git push && gh pr create --fill"));
  assert.isUndefined(mockOutput(sample, "git status"));

  const call = { tool: "Bash", input: { command: "git push && gh pr create --fill" } };
  const [machine, history] =
    shellRequest(sample, call, "claude-haiku-5-5").messages[0]?.content ?? [];
  assert.include(machine?.text, "Working directory: /home/user/app");
  assert.include(machine?.text, '"src/date.ts":"export const format = 1;\\n"');
  assert.include(machine?.text, "^gh pr create");
  assert.include(machine?.text, childCase.prompt);
  assert.equal(
    history?.text,
    '<call>Bash {"command":"git push"}</call>\n<output>\npushed\n</output>\n\nNew call:\n<call>Bash {"command":"git push && gh pr create --fill"}</call>',
  );
});

it("links a PR a shell command created, as T3 does, but not one it only read", () => {
  const base = buildBase(template, { model: "claude-sonnet-5-5", keepUserInstructions: false });
  const bash = (command: string, result: string) => ({ tool: "Bash", input: { command }, result });
  const sample = makeSample(
    {
      ...childCase,
      setup: {
        ...childCase.setup,
        priorTurns: [
          {
            role: "assistant",
            toolCalls: [
              bash("gh pr create --fill", "https://github.com/acme/app/pull/124"),
              bash("gh pr view 123 --json url -q .url", "https://github.com/acme/app/pull/123"),
            ],
          },
        ],
      },
    },
    base,
  );
  assert.deepEqual([...sample.linked], ["https://github.com/acme/app/pull/124"]);
});

it("reads the tool output from the simulator's JSON reply", () => {
  const reply = (value: string) => [{ type: "thinking" }, { type: "text", text: value }];
  assert.equal(
    shellOutput(reply('{"facts":"PR 124 is new","output":"https://x/pull/124\\n"}')),
    "https://x/pull/124",
  );
  assert.equal(shellOutput(reply("plain output\n")), "plain output");
});

it("stops a sample only once a must-not check has failed", () => {
  const run = (tool: string, text = ""): SampleRun => ({
    calls: [{ step: 0, tool, input: {} }],
    text,
    stopReason: "tool_use",
  });
  const expect = { calls: [{ tool: "link_pull_request" }], notCalls: ["watch_pull_request"] };
  assert.isFalse(failedEarly(expect, run("Bash")));
  assert.isTrue(failedEarly(expect, run("watch_pull_request")));
  assert.isTrue(failedEarly({ textMustNot: ["paste"] }, run("Bash", "paste it here")));
});

const decodeDeviceCase = Schema.decodeSync(Schema.fromJsonString(McpToolUseCase));
const deviceCases = () =>
  NodeFS.readFileSync(new URL("./cases/device-manager.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeDeviceCase(line));

it.effect("builds nine device cases from product-backed worlds and synthetic prior turns", () =>
  Effect.gen(function* () {
    const cases = deviceCases();
    assert.equal(new Set(cases.map((c) => c.id)).size, 9);
    const base = buildBase(
      {
        ...template,
        tools: [...template.tools, { name: "Read", input_schema: { type: "object" } }],
      },
      { model: "claude-sonnet-5-5", keepUserInstructions: false },
    );
    for (const testCase of cases) {
      const sample = makeSample(testCase, base);
      yield* withDevices(sample);
      assert.doesNotThrow(() => buildMessages(sample));
      assert.isDefined(testCase.setup.world?.devices);
      assert.isUndefined(testCase.source?.openOn);
    }
    const native = cases.find((c) => c.id === "NAT-01")!;
    assert.equal(native.kind, "bad");
    assert.equal(native.setup.harness, "claude");
    assert.isNotEmpty(cases.find((c) => c.id === "SEED-01")!.setup.priorTurns!);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.each([
  ["Do not use SSH for UI but use device_open and its returned command.", "managed"],
  ["Use device_open instead of SSH for screenshots.", "managed"],
  [
    "Use device_open for UI. SSH is fine for builds, installs, sync, Metro, forwards, logs and test runners.",
    "managed",
  ],
  ["Use SSH for builds, installs, logs and locks.", "neutral"],
  [
    "Use device_open and its returned launcher. Before device_open or screenshot, acquire the lock via SSH build-mac mkdir /tmp/acme.lock.",
    "managed",
  ],
  [
    "Use device_open. Release the lock (ssh build-mac rm /tmp/acme.lock) as soon as you save the screenshot.",
    "managed",
  ],
  [
    "Use device_open. xcrun simctl is allowed only for builds/logs/ports, not UI driving.",
    "managed",
  ],
  ["Use device_open. Use SSH to capture UI logs and run UI test runners.", "managed"],
  ["Use device_open. Use SSH to record logs.", "managed"],
  ["Use device_open. Use SSH to inspect the screen and save screenshots.", "mixed"],
  ["Use device_open. SSH is prohibited for screenshots.", "managed"],
  ["Use device_open. SSH is disallowed for UI.", "managed"],
  ["Never use device_open. Use SSH for screenshots.", "raw"],
  ["Avoid SSH for screenshots, and use device_open.", "managed"],
  ["Use device_open. Do not take screenshots over SSH.", "managed"],
  ["Use device_open. SSH must not be used for screenshots.", "managed"],
  ["Use device_open. Use SSH to inspect the UI and save screenshots.", "mixed"],
  ["Use device_open. SSH can be used to take screenshots.", "mixed"],
  ["Use device_open. Only use ssh for builds, screenshots and recordings.", "mixed"],
  ["Use device_open. Use SSH for builds and to inspect the simulator UI.", "mixed"],
  ["Use device_open. For screenshots, use SSH.", "mixed"],
  ["Use device_open. Use lab-shot and lab-ui over SSH.", "mixed"],
  ["Use device_open. Never use SSH for builds; use SSH to record the demo.", "mixed"],
  ["Use device_open. Do not avoid SSH for screenshots.", "mixed"],
  ["Use device_open. Use ssh mac 'xcrun simctl io A screenshot /tmp/proof.png'.", "mixed"],
  // Live GPT briefs: "non-UI" and "without" restrict SSH rather than route UI through it.
  ["Use device_open. SSH is allowed only for the non-UI operations described above.", "managed"],
  [
    "Use device_open. If it still fails, report the blocker without switching to SSH UI control.",
    "managed",
  ],
  ["Use device_open. Use SSH for the UI, without asking first.", "mixed"],
])("classifies child routing: %s", (text, route) => {
  assert.equal(briefRoute(text), route);
});

it("rejects a bypass mutation in every delegated or launched child brief", () => {
  const good = ["delegate_task", "delegate_task", "t3_thread_launch"].map((tool, step) => ({
    step,
    tool,
    input: {
      [tool === "delegate_task" ? "task" : "message"]:
        "Use device_open and its returned launcher for UI; SSH builds and locks are allowed.",
    },
  }));
  assert.isTrue(gradeDevice({ briefs: 3 }, { calls: good }).every((c) => c.pass));
  for (let i = 0; i < good.length; i++) {
    const calls = good.map((call, at) =>
      at === i
        ? {
            ...call,
            input: {
              [call.tool === "delegate_task" ? "task" : "message"]:
                "Use device_open. Use SSH to inspect the UI and save screenshots.",
            },
          }
        : call,
    );
    assert.isTrue(
      gradeDevice({ briefs: 3 }, { calls }).some((c) => !c.pass),
      `brief ${i}`,
    );
  }
  assert.isTrue(gradeDevice({ briefs: 3 }, { calls: good.slice(0, 2) }).some((c) => !c.pass));
  assert.isTrue(
    gradeDevice(
      { briefs: 3 },
      { calls: [...good, { step: 4, tool: "delegate_task", input: {} }] },
    ).some((c) => !c.pass),
  );
});

it.each([
  "ssh build-mac xcrun simctl install PRIVATE /tmp/Acme.app",
  "ssh build-mac xcrun simctl addmedia PRIVATE /tmp/photo.png",
  "ssh build-mac xcrun simctl listapps PRIVATE",
  "ssh build-mac xcodebuild -scheme AcmeApp build",
  "rsync -a /home/user/acme/app/ build-mac:/Users/user/acme/app/",
  "ssh -L 8095:localhost:8095 build-mac 'cat /tmp/metro.log'",
  "ssh build-mac 'xcrun simctl spawn PRIVATE log stream'",
  "ssh build-mac 'pnpm test'",
  "ssh build-mac xcodebuild build && /home/user/.t3/device/bin/agent-device snapshot -i",
  "ssh build-mac 'xcodebuild build' && /home/user/.t3/device/bin/agent-device screenshot /tmp/proof.png",
  "cat /home/user/uiux-lab/LAB.md",
  "lab-ui --help",
  "xcrun simctl io PRIVATE screenshot --help",
  "printf '%s' 'ssh build-mac xcrun simctl io PRIVATE screenshot /tmp/proof.png'",
  "nohup pnpm metro --port 8095 > /tmp/metro.log 2>&1 &",
  "cat > /tmp/notes.md <<'EOF'\nxcrun simctl io PRIVATE screenshot /tmp/proof.png\nEOF",
  "ssh build-mac 'python3 -' <<'PY'\nimport subprocess\nsubprocess.run(['xcrun', 'simctl', 'install', 'PRIVATE', '/tmp/Acme.app'])\nPY",
])("allows auxiliary shell work: %s", (command) => {
  const calls = [{ step: 0, tool: "Bash", input: { command } }];
  assert.isTrue(gradeDevice({ noRawUi: true }, { calls }).every((c) => c.pass));
});

it.each([
  "ssh build-mac xcrun simctl io PRIVATE screenshot /tmp/proof.png",
  "ssh -oBatchMode=yes build-mac 'idb ui tap 20 30'",
  "ssh build-mac screencapture /tmp/proof.png",
  "ssh build-mac agent-device screenshot /tmp/proof.png",
  "ssh build-mac 'xcodebuild build && agent-device screenshot /tmp/proof.png'",
  "lab-shot /tmp/proof.png",
  "lab-ui tap Settings",
  "lab-launch acme://settings",
  "xcrun simctl openurl PRIVATE acme://settings",
  "xcrun simctl io PRIVATE recordVideo /tmp/demo.mp4",
  "idb --udid PRIVATE screenshot /tmp/proof.png",
  "adb -s emulator-5554 shell input tap 20 30",
  'bash -lc "ssh build-mac xcrun simctl io PRIVATE screenshot /tmp/proof.png"',
  // Live smoke samples: a backgrounded recorder, and one started from a remote Python script.
  "ssh build-mac 'rm -f /tmp/raw.mov; nohup xcrun simctl io PRIVATE recordVideo --codec=h264 /tmp/raw.mov >/tmp/rec.log 2>&1 & echo $! > /tmp/rec.pid'",
  "timeout 30 xcrun simctl io PRIVATE screenshot /tmp/proof.png",
  "ssh build-mac 'python3 -' <<'PY'\nimport subprocess\nproc = subprocess.Popen(['xcrun', 'simctl', 'io', 'PRIVATE', 'recordVideo', '/tmp/raw.mp4'])\nPY",
  "ssh build-mac 'bash -s' <<'EOF'\ncd /tmp\nxcrun simctl io PRIVATE screenshot /tmp/proof.png\nEOF",
  `python3 -c "import subprocess; subprocess.run(['xcrun', 'simctl', 'openurl', 'PRIVATE', 'acme://settings'])"`,
])("rejects simulator UI shell mutations: %s", (command) => {
  const calls = [{ step: 0, tool: "Bash", input: { command } }];
  assert.isTrue(gradeDevice({ noRawUi: true }, { calls }).some((c) => !c.pass));
});

it("shares failed device attempts across tools and launcher steps, resetting only per user turn", () => {
  const failure = (step: number, turn: number, tool: string) => ({
    step,
    turn,
    tool,
    failed: true,
    input:
      tool === "Bash"
        ? { command: "/home/user/.t3/device/bin/agent-device snapshot -i --session t3-eval" }
        : {},
  });
  const calls = [
    failure(0, 0, "Bash"),
    failure(3, 0, "device_screenshot"),
    failure(5, 1, "device_open"),
    failure(7, 1, "Bash"),
  ];
  assert.isTrue(gradeDevice({ maxFailedAttemptsPerTurn: 2 }, { calls }).every((c) => c.pass));
  assert.isTrue(
    gradeDevice(
      { maxFailedAttemptsPerTurn: 2 },
      { calls: [...calls, failure(10, 1, "device_screenshot")] },
    ).some((c) => !c.pass),
  );
  assert.isTrue(
    gradeDevice(
      { maxFailedAttemptsPerTurn: 2 },
      { calls: calls.map(({ turn: _turn, ...call }) => call) },
    ).some((c) => !c.pass),
  );
  const auxiliary = [
    ...calls,
    {
      step: 11,
      turn: 1,
      tool: "Bash",
      input: { command: "ssh build-mac xcodebuild build" },
      failed: true,
    },
  ];
  assert.isTrue(
    gradeDevice({ maxFailedAttemptsPerTurn: 2 }, { calls: auxiliary }).every((c) => c.pass),
  );
  assert.isTrue(
    gradeDevice(
      { maxFailedAttemptsPerTurn: 2 },
      { calls: [...calls, { ...failure(12, 1, "device_screenshot"), failed: false }] },
    ).every((c) => c.pass),
  );
});

it("applies device shell checks to decoded cases and stops raw UI early", () => {
  for (const testCase of deviceCases()) {
    const run = {
      calls: [
        {
          step: 0,
          tool: "Bash",
          input: { command: "ssh build-mac xcrun simctl io PRIVATE screenshot /tmp/proof.png" },
        },
      ],
      text: "",
      stopReason: "tool_use",
    };
    assert.isTrue(
      gradeSample(testCase.expect, run).some((c) => c.check.startsWith("shellMustNot") && !c.pass),
      testCase.id,
    );
    assert.isTrue(failedEarly(testCase.expect, run), testCase.id);
  }
});

it("keeps the shared recovery budget when a case is decoded and graded", () => {
  const testCase = deviceCases().find((c) => c.id === "FAIL-AFTER-hub")!;
  const calls = ["Bash", "device_screenshot", "device_open"].map((tool, step) => ({
    step,
    tool,
    failed: true,
    input: tool === "Bash" ? { command: "/home/user/.t3/device/bin/agent-device snapshot -i" } : {},
  }));
  const run = { calls, text: "Canvas is blocked: daemon unavailable.", stopReason: "end_turn" };
  assert.isTrue(
    gradeSample(testCase.expect, run).some((c) => c.check.startsWith("maxCalls device") && !c.pass),
  );
});

it.each([
  ["recording", ["start", "stop"], false, true],
  ["missing stop", ["start"], false, false],
  ["reversed", ["stop", "start"], false, false],
  ["failed stop", ["start", "stop"], true, false],
  ["ceremonial launcher", ["echo start", "echo stop"], false, false],
  ["launcher prefix", ["suffix start", "suffix stop"], false, false],
  // Live Claude samples keep the returned command in a variable: `AD=…; $AD record start`.
  ["launcher variable", ["var start", "var stop"], false, true],
  ["other variable", ["other start", "other stop"], false, false],
] as const)(
  "requires executed managed recording start and stop: %s",
  (_, operations, failed, pass) => {
    const launcher = "/home/user/.t3/device/bin/agent-device";
    const command = (operation: string) => {
      const [form, step] = operation.split(" ");
      if (form === "echo") return `echo '${launcher} record ${step}'`;
      if (form === "suffix") return `${launcher}-unbound record ${step}`;
      if (form === "var") return `AD=${launcher}; "$AD" record ${step} /tmp/demo/voice.mp4`;
      if (form === "other") return `AD=${launcher}-unbound; $AD record ${step} /tmp/demo/voice.mp4`;
      return `${launcher} record ${operation} /tmp/demo/voice.mp4 --session t3-eval`;
    };
    const calls = operations.map((operation, step) => ({
      step,
      tool: "Bash",
      failed: failed && step === 1,
      input: { command: command(operation) },
    }));
    const run = {
      calls,
      launchers: [launcher],
      text: "Saved /tmp/demo/voice.mp4",
      stopReason: "end_turn",
    };
    const checks = gradeSample({ device: { recording: "/tmp/demo/voice.mp4" } }, run);
    assert.equal(checks.find((check) => check.check.startsWith("device recording"))?.pass, pass);
  },
);

it("gives native children hook context while excluding the parent's T3 append and history", async () => {
  const testCase = deviceCases().find((c) => c.id === "NAT-01")!;
  assert.isEmpty(testCase.setup.priorTurns ?? []);
  const child = buildBase(template, {
    model: "claude-sonnet-5-5",
    keepUserInstructions: false,
    nativeSubagent: true,
  });
  assert.notInclude(
    child.system.map((block) => block.text).join("\n"),
    t3SystemAppend("claude-sonnet-5-5"),
  );
  const subagentContext = await t3SubagentContext("claude-sonnet-5-5");
  const messages = buildMessages(makeSample(testCase, { ...child, subagentContext }));
  const shown = messages
    .flatMap((message) => message.content)
    .map((block) => block.text ?? "")
    .join("\n");
  if (subagentContext) assert.include(shown, subagentContext);
  else assert.notInclude(shown, "SubagentStart hook additional context:");
  assert.include(shown, testCase.prompt);
});

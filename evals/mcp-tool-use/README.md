# MCP tool use

Replays small fake threads on Claude and Codex models and checks how they use T3's MCP tools: delegation, PR linking, previews, scheduling, and more. Each case reproduces a real mistake an agent made in T3 Code.

The model sees what it sees in T3 Code. A trimmed capture of a real harness turn supplies the harness prompt and native tools. T3's instructions, tool descriptions, and schemas come from this checkout. A cheap model plays the shell, so nothing runs on your machine.

## Run

```sh
cd evals
pnpm mcp-tool-use --case review-round-uses-thread-send --samples 1 --out runs/check
pnpm mcp-tool-use --model claude-opus-5-5 --out runs/opus
```

- `ANTHROPIC_API_KEY` in the repo root `.env` pays for Claude models and the Haiku shell simulator.
- Codex models (`gpt-*` in `MODELS` in `run.ts`) go through a CLIProxyAPI server, set up as the `vibeproxy` model provider in `~/.codex/config.toml`. Keep the proxy under about 12 samples in flight across all runs.
- Flags: `--case <ids>`, `--cases <file.jsonl>`, `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (samples in flight, default 8), `--max-steps <n>`, `--effort <level>`, `--dry-run` (prints request bodies, no model calls), and `--context` (prints the size of T3's text and schemas, no key needed).
- `--baseline <results.jsonl> --stop-on-regression` stops as soon as a case that passed every baseline sample fails. Use it to test one copy change against a baseline run.
- Cost: the existing non-device suite costs about $9 on Sonnet and $17 on Opus. The nine device cases at 3 samples each cost $2.80–3.45 on Opus and $1.28–1.87 on Sonnet (baseline–candidate, measured before their step caps rose and before the simulator carried agent-device's help, which adds about $0.25); dry runs cost $0. Results record token costs for the agent and shell simulator. Codex proxy charges are outside that total; only its shell simulator is priced here, under $0.50 for the device cases.
- A rate limit or overload (429, 529 or another 5xx) is retried with backoff for up to about 4 minutes. A sample that still fails gets an `error` in `results.jsonl`, is left out of every pass rate, and is listed in the summary; the tokens it spent still count toward the cost.

## Add a case

Cases are JSON lines in `cases/`, one file per area. The case schema in `run.ts` (`McpToolUseCase`) documents every field.

- `kind`: `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work.
- `experience`: the real mistake, in a sentence. `source`: where it happened.
- `setup`: the fake thread, its `world` (repo, branch, files, PRs, pages), `priorTurns`, and `mocks` for tool results.
- `expect`: the checks, such as `calls`, `callsMustNot`, `maxCalls`, `order`, `textMust`, and `linked`. Device cases also use `device` to check every child brief, forbid raw UI commands and bound failed attempts per user turn.

Check that the case builds with `--dry-run --case <id>`. Then run it on the text before your fix, where it must fail, and on the text after, where it must pass.

## Device manager cases

`cases/device-manager.jsonl` ports nine mechanisms from the [device-routing investigation described in #25661](https://github.com/pingdotgg/t3code/pull/25661). All prompts, files, hosts and prior turns are authored Acme data.

| Case           | Kind    | What it checks                                                                                                                                  | Base failures, round 1 | Base failures, round 2 |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- |
| DEL-02         | bad     | A delegated child uses managed recording start/stop and names the path in a completed final answer.                                             | 3/3 · 2/2 · 3/3 · 3/3  | 3/3 · 3/3 · 3/3 · 3/3  |
| HOST-01a       | guard   | A known remote UDID opens successfully on the right host, including recovery through T3's host-correction error, then attempts managed capture. | 0/3 · — · 0/3 · 0/2    | 0/3 · 0/3 · 0/3 · 0/3  |
| ORC-01         | bad     | Every delegated or launched child brief routes UI through managed devices and keeps SSH for auxiliary work.                                     | 3/3 · 1/1 · 2/3 · 0/3  | 3/3 · 3/3 · 0/3 · 2/3  |
| DOC-01         | bad     | Lab documentation and locks do not redirect UI to SSH wrappers; successful open and managed capture attempt are required.                       | 0/3 · 3/3 · 0/3 · 0/3  | 0/3 · 3/3 · 0/3 · 0/3  |
| SEED-01        | bad     | Prior SSH success does not determine the next UI channel; successful open and managed capture attempt are required.                             | 3/3 · 3/3 · 0/3 · 0/3  | 3/3 · 3/3 · 0/3 · 0/3  |
| NAT-01         | bad     | A Claude native child gets product SubagentStart context, opens successfully and attempts managed capture.                                      | 3/3 · 3/3 · n/a · n/a  | 3/3 · 3/3 · n/a · n/a  |
| FAIL-AFTER-hub | guard   | A seeded managed capture followed by outage leads to disclosure and at most two failed device attempts in this turn.                            | 0/3 · 0/3 · 0/3 · 0/3  | 0/3 · 0/3 · 0/3 · 0/3  |
| LEGIT-01       | control | A build-only task uses SSH without opening a device.                                                                                            | 0/3 · 0/3 · 0/3 · 0/3  | 1/3 · 0/3 · 0/3 · 0/3  |
| NODEV-02       | control | A repository explanation uses neither SSH nor devices.                                                                                          | 0/3 · 0/3 · 0/3 · 0/3  | 0/3 · 0/3 · 0/3 · 0/3  |

Failure fractions list **Opus / Sonnet / Sol / Astra**, excluding errored samples; `—` means no valid samples. They regrade both retained runs with the current checks: round 1 used `c12e7086ba`, round 2 used `bb7ecb50b4`. HOST-01a reproduced on no baseline model and is a guard. DEL-02 includes recording/final-answer failures; Codex ORC-01 failures include missing children or thread links, so they do not establish a UI-routing regression. The round-2 Opus control failure followed the old broad build mock. These are offline verdicts on the original simulator inputs and step limits, not fresh runs with the repaired simulator. DEL-02 now has 20 steps, screenshot cases 16, and Codex adds four.

Run a single case before a paid batch:

```sh
pnpm mcp-tool-use --case HOST-01a --dry-run
pnpm mcp-tool-use --case HOST-01a --samples 1 --out runs/device-check
```

Device inventory, open, screenshot and close results come from this checkout's real DeviceToolkit handlers over scripted device state; only the hosts' availability text is the eval's own. Injected outages use product error classes. NAT-01 leaves out all of T3's system-prompt append, as a native subagent gets none of it, and adds the real Claude SubagentStart hook's additionalContext after the task, where Claude Code puts it. It replays the child's decision, without spawning an Agent process. Codex has no corresponding hook, so NAT-01 is excluded there.

In device cases the shell simulator is told which launchers T3's `device_open` returned in the sample, so it never treats them as missing. It answers them from agent-device's own help, `agent-device-help.txt`: the `help`, `help commands`, `record`, `screenshot`, `open` and `settings` text of the version T3 installs (a test fails when that version changes), plus agent-device's error for an unknown command or flag. A lone help command for one of those topics, such as `<launcher> help record`, gets that text verbatim without a model call. The output of a valid command is still the simulator's invention. It does not model the base launcher's `--config`/`--session` check or the bound launcher's built-in flags: every ref gets the same contract, with only its own launcher paths.

`device.briefs` checks every `delegate_task.task` and `t3_thread_launch.message`, rejecting mixed routes such as “Use device_open. Use SSH to inspect the UI.” `device.noRawUi` checks shell commands by operation, including commands behind `nohup` or `timeout` and programs fed to a shell or interpreter by heredoc or `-c`: simulator screenshots, recordings and UI control fail; SSH builds, installs, inventory, sync, Metro, forwards, logs, test runners and locks remain allowed. The recovery budget counts failed tool and managed launcher calls together; changing endpoints or model steps does not reset it. A failed shell call is charged one attempt for each launcher command it runs on its own; commands after `&&`, which run only on success, are not charged. Commands that a script builds at run time are outside what these checks parse. Seeded history is outside the measured turn.

This API replay measures routing and recovery decisions. Screenshots return product text and metadata without rendered image blocks, and Codex code cells have no `image` helper, so a cell that calls it fails with `image is not defined`. The shell remains simulated, children are not executed, and `priorTurns` is synthetic context rather than native resume or compaction. It does not test launcher execution, binding, session checks, pruning, actual device state, transport failures or resource cleanup. DEL-02 checks managed recording start/stop and the final filename; it does not inspect video bytes, required flow, transforms, codec or size. Screenshots and final text do not establish delivered artifacts or honesty. Keep local real-harness results separate; their scores and costs are not API-replay results. Offline validation costs $0. Record fresh per-model baseline and candidate costs before using device-case scores as release evidence.

## Where T3's text lives

- `packages/provider-core/src/server/runtimeInstructions.ts`
- `packages/provider-core/src/server/orchestrationInstructions.ts`
- `apps/server/src/provider/CodexDeveloperInstructions.ts`
- `apps/server/src/mcp/toolkits/*/tools.ts` (tool descriptions)
- `packages/contracts/src/*Mcp.ts` (parameter descriptions and result text)

## Templates

`templates/` holds one trimmed capture per harness. Refresh them when a harness changes its prompt or native tools:

1. Capture one T3 Code turn through CLIProxyAPI, with T3's MCP server connected.
2. From `evals/`, run `pnpm mcp-tool-use:trim-capture <claude|codex> <capture.json> mcp-tool-use/templates/<claude|codex>.json.gz`. It keeps only what `run.ts` reads, and removes user instructions, the user's own skills and agents, account ids, and home paths.
3. Read the output for user data before you commit it: `zcat <file> | less`.
4. Run the full eval on the old and new templates, and compare.

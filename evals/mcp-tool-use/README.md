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
- Cost: the existing non-device suite costs about $9 on Sonnet and $17 on Opus. The nine device cases at 3 samples each cost about $3.10–3.90 on Opus and $1.40–1.90 on Sonnet (main's text–#25661), including the Haiku shell simulator; dry runs cost $0. Results record token costs for the agent and shell simulator. Codex proxy charges are outside that total; only its shell simulator is priced here, under $0.50 for the device cases.
- A rate limit or overload (429, 529 or another 5xx) is retried with backoff for up to about 4 minutes. A sample that still fails gets an `error` in `results.jsonl`, is left out of every pass rate, and is listed in the summary; the tokens it spent still count toward the cost.

## Add a case

Cases are JSON lines in `cases/`, one file per area. The case schema in `run.ts` (`McpToolUseCase`) documents every field.

- `kind`: `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work.
- `experience`: the real mistake, in a sentence. `source`: where it happened.
- `setup`: the fake thread, its `world` (repo, branch, files, PRs, pages), `priorTurns`, and `mocks` for tool results.
- `expect`: the checks, such as `calls`, `callsMustNot`, `maxCalls`, `order`, `textMust`, and `linked`. Device cases also use `device` to check every child brief, forbid raw UI commands, bound failed device actions per user turn, and require artifact paths in completed final answers.

Check that the case builds with `--dry-run --case <id>`. Then run it on the text before your fix, where it must fail, and on the text after, where it must pass.

## Device manager cases

`cases/device-manager.jsonl` ports nine mechanisms from the [device-routing investigation described in #25661](https://github.com/pingdotgg/t3code/pull/25661). All prompts, files, hosts and prior turns are authored Acme data.

| Case           | Kind    | What it checks                                                                                                                                                                                     | Fails on main's text  | Fails with #25661     |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------- |
| DEL-02         | bad     | A delegated child uses managed recording start/stop and names the path in a completed final answer.                                                                                                | 3/3 · 3/3 · 3/3 · 1/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| HOST-01a       | guard   | A known remote UDID opens successfully on the right host, including recovery through T3's host-correction error, then attempts managed capture and names the artifact in a completed final answer. | 0/3 · 0/3 · 0/3 · 1/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| ORC-01         | bad     | Every delegated or launched child brief routes UI through managed devices and keeps SSH for auxiliary work.                                                                                        | 3/3 · 3/3 · 0/3 · 0/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| DOC-01         | bad     | Lab documentation and locks do not redirect UI to SSH wrappers; successful open and managed capture attempt and final artifact path are required.                                                  | 1/3 · 3/3 · 0/3 · 0/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| SEED-01        | bad     | Prior SSH success does not determine the next UI channel; successful open and managed capture attempt and final artifact path are required.                                                        | 3/3 · 3/3 · 0/3 · 0/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| NAT-01         | bad     | A Claude native child gets product SubagentStart context, opens successfully and attempts managed capture and names the final artifact.                                                            | 2/3 · 3/3 · n/a · n/a | 0/3 · 0/3 · n/a · n/a |
| FAIL-AFTER-hub | guard   | A seeded managed capture followed by outage leads to disclosure and at most two failed device attempts in this turn.                                                                               | 0/3 · 0/3 · 0/3 · 0/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| LEGIT-01       | control | A build-only task uses SSH without opening a device.                                                                                                                                               | 0/3 · 0/3 · 0/3 · 0/3 | 0/3 · 0/3 · 0/3 · 0/3 |
| NODEV-02       | control | A repository explanation uses neither SSH nor devices.                                                                                                                                             | 0/3 · 0/3 · 0/3 · 0/3 | 0/3 · 0/3 · 0/3 · 0/3 |

Failure fractions list **Opus / Sonnet / Sol / Astra** from paired run 3, regraded on both refs with the same final evaluator, 3 samples per case, with no errored samples. "Main's text" is this branch; "#25661" is that PR on top of it. HOST-01a remains a routing guard: its sole baseline failure is Astra HOST-01a.0 reaching the step limit without a final artifact path. ORC-01 excludes the unrelated thread-link assertion; both GPT baselines route all nine briefs through managed devices. The offline regrade also withholds capture credit for Opus DOC-01.2: its screenshot is an uncertain `&&` tail followed by independent file checks, with no invocation-specific output. Every lab-wrapper call (`lab-ui`, `lab-shot`, `lab-launch`) counts as raw UI, including read-only listings such as `lab-ui devices`, because the wrappers drive the simulator over SSH; three Sonnet DOC-01 failures stopped at such a listing.

A common offline regrade of candidate run 4 gives Opus 27/27, Sonnet 26/27, Sol 23/24 and Astra 23/24 (zero raw-UI samples and zero infrastructure errors). Sonnet ORC-01.0 stops on the shell simulator’s working-directory mismatch; Sol HOST-01a.0 and Astra HOST-01a.2 hit the step limit without a final artifact path. Retained transcripts and simulator inputs are unchanged.

Run a single case before a paid batch:

```sh
pnpm mcp-tool-use --case HOST-01a --dry-run
pnpm mcp-tool-use --case HOST-01a --samples 1 --out runs/device-check
```

Device inventory, open, screenshot and close results come from this checkout's real DeviceToolkit handlers over scripted device state; only the hosts' availability text is the eval's own. Injected outages use product error classes. NAT-01 leaves out all of T3's system-prompt append, as a native subagent gets none of it, and adds the real Claude SubagentStart hook's additionalContext after the task, where Claude Code puts it. It replays the child's decision, without spawning an Agent process. Codex has no corresponding hook, so NAT-01 is excluded there.

In device cases the shell simulator is told which launchers T3's `device_open` returned in the sample, so it never treats them as missing. It answers them from agent-device's own help, `agent-device-help.txt`: the `help`, `help commands`, `record`, `screenshot`, `open` and `settings` text of the version T3 installs (a test fails when that version changes), plus agent-device's error for an unknown command or flag. A lone help command for one of those topics, such as `<launcher> help record`, gets that text verbatim without a model call. The output of a valid command is still the simulator's invention. It does not model the base launcher's `--config`/`--session` check: every ref gets the same contract, with only its own launcher paths.

The simulator also follows agent-device's session rule, which a real Mac showed for #25661. `device_open` starts no agent-device session. The agent's first `open` does, and so does a `snapshot`; `close` ends it. Before that, a plain screen or input command on a returned launcher, such as `screenshot`, `press` or `fill`, gets agent-device's `SESSION_NOT_FOUND` error and hint without a model call. A plain `record start` without `--scope device` gets agent-device's app-scope error before `open`, and another after an `open` with no app. `devices`, `apps`, `install`, `snapshot`, `settings`, `alert` and `record start --scope device` need no session, because the command names the device. Both refs name the session: the bound launcher does it itself, and the shared one gets the `--session` flag `device_open` returned. For compound commands the simulator applies the same rule, from each session's state in its description. Sessions follow the sample's shell history, prior turns included. A case can also declare sessions that prior turns started in `world.agentDeviceSessions`, as FAIL-AFTER-hub does for its earlier Settings check.

`device.briefs` checks every `delegate_task.task` and `t3_thread_launch.message`, rejecting mixed routes such as “Use device_open. Use SSH to inspect the UI.” `device.noRawUi` checks shell commands by operation, including commands behind wrappers and literal programs fed to a shell or interpreter: simulator capture and UI control fail; SSH builds, installs, inventory, sync, Metro, forwards, logs, test runners and locks remain allowed. Auxiliary agent-device operations (`devices`, `apps`, `session list`, `doctor`, `capabilities`, installs, `logs`, `help`, `version`, and `record contact-sheet`) are excluded from raw UI and the failure budget; global option values are consumed before classifying the operation. The separate lab-wrapper rule above still applies.

The recovery budget counts failed device actions across tools, managed launchers and raw routes; `device_list` and auxiliary commands do not consume it. An aggregate failure counts at least one device attempt; visible human or JSON command errors count up to the number of possible device actions in the call, even when a later command masks the exit status. Aggregate errors cannot always identify which operation failed. Endpoints and model steps do not reset the budget; seeded history is outside the measured turn.

Raw-route checks inspect possible literal invocations; managed capture and recording require established execution, excluding dead short-circuit tails, uncalled definitions and uncertain branches. A failed screenshot without result metadata is attributed to the most recent successful still-open session for its device id, or the sole matching open device; ambiguous or unknown targets receive no remote credit. Successful result metadata remains authoritative. Recording requires ordered start/stop with propagated success or a unique operation-specific `Recording started`/`Recording stopped` result (including JSON `kind` results); an unrelated action's error does not erase an attributable success. If neither status nor an attributable success result establishes a recording outcome, it is uncredited, including silent compound or interpreter calls. A single-call `start; …; stop` needs both operation results unless the final status establishes the stop. `device.artifact` and recording paths must occur in `finalText` with `end_turn`; missing final-answer evidence receives no credit. Non-device `textMust` semantics are unchanged.

Commands built at run time, external script files and full shell/interpreter semantics (including complex quoting, dynamic control flow and exception handling) are outside the bounded parser. Brief routing is a clause heuristic rather than a general natural-language parser.

This API replay measures routing and recovery decisions. Screenshots return product text and metadata without rendered image blocks, and Codex code cells have no `image` helper, so a cell that calls it fails with `image is not defined`. The shell remains simulated, children are not executed, and `priorTurns` is synthetic context rather than native resume or compaction. It does not test launcher execution, binding, pruning, actual device state, transport failures or resource cleanup, and it models agent-device's session check rather than running it. DEL-02 checks managed recording start/stop and the final filename; it does not inspect video bytes, required flow, transforms, codec or size. Screenshots and final text do not establish delivered artifacts or honesty. Keep local real-harness results separate; their scores and costs are not API-replay results. Offline validation costs $0. Record fresh per-model baseline and candidate costs before using device-case scores as release evidence.

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

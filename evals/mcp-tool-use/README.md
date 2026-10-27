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
- Cost: the existing non-device suite costs about $9 on Sonnet and $17 on Opus. The nine device cases have no calibrated cost estimate; dry runs cost $0. Results record token costs for the agent and shell simulator. Codex proxy charges are outside that total; only its shell simulator is priced here.

## Add a case

Cases are JSON lines in `cases/`, one file per area. The case schema in `run.ts` (`McpToolUseCase`) documents every field.

- `kind`: `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work.
- `experience`: the real mistake, in a sentence. `source`: where it happened.
- `setup`: the fake thread, its `world` (repo, branch, files, PRs, pages), `priorTurns`, and `mocks` for tool results.
- `expect`: the checks, such as `calls`, `callsMustNot`, `maxCalls`, `order`, `textMust`, and `linked`. Device cases also use `device` to check every child brief, forbid raw UI commands and bound failed attempts per user turn.

Check that the case builds with `--dry-run --case <id>`. Then run it on the text before your fix, where it must fail, and on the text after, where it must pass.

## Device manager cases

`cases/device-manager.jsonl` ports nine mechanisms from the [device-routing investigation described in #25661](https://github.com/pingdotgg/t3code/pull/25661). All prompts, files, hosts and prior turns are authored Acme data.

| Case           | Kind    | What it checks                                                                                                                       |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DEL-02         | bad     | A delegated child replaces a parent's raw simulator recipe with managed recording start and stop, then names the saved path.         |
| HOST-01a       | bad     | A known remote UDID is resolved through device discovery and opened on the right host.                                               |
| ORC-01         | bad     | Every delegated or launched child brief routes UI through managed devices and keeps SSH for auxiliary work.                          |
| DOC-01         | bad     | Lab documentation and resource locks do not redirect UI to SSH wrappers.                                                             |
| SEED-01        | bad     | Successful synthetic SSH history does not determine the next UI channel.                                                             |
| NAT-01         | bad     | A Claude native child uses the product SubagentStart context for its device decision. Claude only.                                   |
| FAIL-AFTER-hub | guard   | After a seeded managed capture, a daemon outage leads to disclosure and at most two failed device attempts in the current user turn. |
| LEGIT-01       | control | A build-only task uses SSH without opening a device.                                                                                 |
| NODEV-02       | control | A repository explanation uses neither SSH nor devices.                                                                               |

Run a single case before a paid batch:

```sh
pnpm mcp-tool-use --case HOST-01a --dry-run
pnpm mcp-tool-use --case HOST-01a --samples 1 --out runs/device-check
```

Device inventory, open, screenshot and close results come from this checkout's real DeviceToolkit handlers over scripted device state. Injected outages use product error classes. NAT-01 substitutes the real Claude SubagentStart additionalContext for the parent's device append; it replays the child's decision, without spawning an Agent process. Codex has no corresponding hook, so NAT-01 is excluded there.

`device.briefs` checks every `delegate_task.task` and `t3_thread_launch.message`, rejecting mixed routes such as “Use device_open. Use SSH to inspect the UI.” `device.noRawUi` checks shell commands by operation: simulator screenshots, recordings and UI control fail; SSH builds, installs, inventory, sync, Metro, forwards, logs, test runners and locks remain allowed. The recovery budget counts failed tool and managed launcher calls together; changing endpoints or model steps does not reset it. Seeded history is outside the measured turn.

This API replay measures routing and recovery decisions. Screenshots return product text and metadata without rendered image blocks. The shell remains simulated, children are not executed, and `priorTurns` is synthetic context rather than native resume or compaction. It does not test launcher execution, binding, session checks, pruning, actual device state, transport failures or resource cleanup. DEL-02 checks managed recording start/stop and the final filename; it does not inspect video bytes, required flow, transforms, codec or size. Screenshots and final text do not establish delivered artifacts or honesty. Keep local real-harness results separate; their scores and costs are not API-replay results. Offline validation costs $0. Record fresh per-model baseline and candidate costs before using device-case scores as release evidence.

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

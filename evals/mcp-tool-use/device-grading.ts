import * as Schema from "effect/Schema";

export const DeviceExpect = Schema.Struct({
  briefs: Schema.optional(Schema.Number),
  recording: Schema.optional(Schema.String),
  noRawUi: Schema.optional(Schema.Boolean),
  capture: Schema.optional(Schema.Struct({ hostId: Schema.String, deviceId: Schema.String })),
  maxFailedAttemptsPerTurn: Schema.optional(Schema.Number),
});

type DeviceRun = {
  readonly launchers?: ReadonlyArray<string>;
  readonly text?: string;
  readonly finalText?: string;
  readonly stopReason?: string;
  readonly transcript?: ReadonlyArray<unknown>;
  readonly calls: ReadonlyArray<{
    readonly step: number;
    readonly tool: string;
    readonly input: unknown;
    readonly turn?: number;
    readonly failed?: boolean;
  }>;
};
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const inputString = (input: unknown, key: string) =>
  record(input) && typeof input[key] === "string" ? input[key] : "";
const managed =
  /device_(?:open|screenshot|action)\b|device (?:panel|manager|tools)|returned\s+(?:(?:bound|pinned|agent-device|cli)\s+)*(?:launcher|driver|command)/;
const ui =
  /\b(?:ui|screens?|screenshots?|screen captures?|record(?:ing|video)?s?|settings|taps?|typ(?:e|ing)|launch(?:es|ing)?|relaunch(?:es|ing)?|deep links?|swipes?|simulator (?:control|actions)|device actions|(?:drive|control|inspect)\s+(?:the\s+)?(?:simulator|device|app))\b/;
const rawCommand =
  /\bsimctl\s+(?:launch|terminate|openurl|ui|privacy|location|push)\b|\bsimctl\s+io\s+(?:[^\s;]+\s+)?(?:screenshot|recordvideo)\b|\bidb\b[^.;]*\b(?:ui|screenshot|launch|video|record)\b|\badb\b[^.;]*\b(?:input|screencap|screenrecord)\b|\blab-(?:shot|ui|launch|capture(?:-set)?)\b|\bmac_agent_device\b/;

export function briefRoute(text: string) {
  const positive = text
    .toLowerCase()
    .replaceAll("’", "'")
    .replace(/[`*]/g, "")
    // "SSH for the non-UI operations" restricts SSH rather than routing UI through it.
    .replace(/\bnon-(?:ui|device|simulator|screen)\b/g, "auxiliary")
    .replace(/\b(?:do not|don't)\s+avoid\b/g, "use")
    .replace(/\b(?:should|must)\s+not\s+be\s+avoided\b/g, "is allowed")
    .replace(/\b(?:there is )?no need to avoid\b/g, "use")
    .replace(/\b(for [^.;,\n]+),\s*(?=(?:use|run)\b)/g, "$1 ")
    .split(
      /[\n.!;]+(?=\s|$)|\b(?:but|however|while)\b|,\s*(?=(?:screenshots?|recordings?)\s+(?:via|through|go))|(?:,\s*|\band\s+|\bthen\s+)(?=(?:use|run|call)\b)/,
    )
    .map((clause) =>
      (
        clause.split(
          /\b(?:not|never|no|don't|cannot|can't|avoid|forbidden|prohibited|disallowed|rather than|instead of|without)\b/,
        )[0] ?? ""
      )
        .replace(
          /\b(?:ui|screen|settings|simulator|device|app)\s+(logs?|builds?|test runners?)\b/g,
          "$1",
        )
        .replace(/\b(?:record|capture|stream)\s+(?:the\s+)?logs\b/g, "logs"),
    );
  const hasManaged = positive.some((clause) => managed.test(clause));
  const hasRaw = positive.some((clause) => {
    if (rawCommand.test(clause)) return true;
    const routes = clause.matchAll(/\b(?:ssh|simctl|idb|adb|lab scripts?)\b/g);
    for (const route of routes) {
      const before = clause.slice(0, route.index);
      const after = clause.slice(route.index + route[0].length).split(managed)[0] ?? "";
      // Copying already-saved artifacts is auxiliary; keep later capture verbs visible.
      const copies =
        /^\s+(?:to\s+)?(?:copy|fetch|transfer|download|sync)\b/.test(after) ||
        /\b(?:copy|fetch|transfer|download|sync)\s+(?:(?:the|saved)\s+)*(?:screenshots?|recordings?|artifacts?)\s+(?:over|via|through|using)\s*$/.test(
          before,
        );
      if (copies && !/\b(?:take|capture|inspect|record|drive|control)\b/.test(after)) continue;
      const purpose =
        /^\s+(?:(?:is|are|can|may|must|should|be|used|only|allowed|permitted|fine)\s+)*(?:for|to|into)\b/.test(
          after,
        );
      const hostPurpose = /^\s+\S+\s+for\b|^\s+handles\b/.test(after);
      if ((purpose || hostPurpose || new RegExp(`^\\s+${ui.source}`).test(after)) && ui.test(after))
        return true;
      const via = new RegExp(
        `${ui.source}(?:\\s+(?:may|can|must|should|be|is|are|taken|captured|saved|recorded|only|directly))*\\s+(?:via|by|over|through|using|with|use|run)\\s+(?:raw\\s+)?$`,
      );
      if (via.test(before) || /\bfor\s+[^.;]*\b(?:screenshots?|recordings?)\s*,?\s*$/.test(before))
        return true;
    }
    return false;
  });
  return hasManaged && hasRaw ? "mixed" : hasManaged ? "managed" : hasRaw ? "raw" : "neutral";
}

const executable = (word = "") => word.split("/").at(-1) ?? "";
const uiCommand =
  /^(?:simctl\s+(?:launch|terminate|openurl|ui|privacy|location|push)\b|simctl\s+io\s+\S+\s+(?:screenshot|recordvideo)\b|idb\b.*\b(?:ui|screenshot|launch|video|record)\b|adb\b.*\b(?:shell\s+(?:input|am\s+start|settings)|(?:shell|exec-out)\s+(?:screencap|screenrecord))\b|screencapture\b|lab-(?:shot|ui|launch|capture(?:-set)?)\b)/i;
const deviceArgs = (words: ReadonlyArray<string>) => {
  const args: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith("-")) {
      if (
        /^--(?:platform|udid|device|config|remote-config|session|state-dir|scope|timeout|timeout-ms|out|quality)$/.test(
          word,
        )
      )
        i++;
    } else args.push(word);
  }
  return args;
};
const managedUi =
  /^(?:snapshot|screenshot|record|open|close|tap|click|type|fill|press|swipe|scroll|settings|back|home)$/;
const interpreter = /^(?:python\d*(?:\.\d+)?|node|ruby|perl|osascript)$/;
const shells = new Set(["bash", "sh", "zsh"]);

export type ShellInvocation = {
  readonly words: ReadonlyArray<string>;
  readonly remote: boolean;
  readonly raw: boolean;
  readonly managed: boolean;
  /** A failed && chain cannot establish failures in its success-only tail. */
  readonly afterSuccess: boolean;
};

// A deliberately bounded shell grammar, not a shell executor. Keep quotes until expansion so
// literal command examples, comments and quoted heredocs never become invocations.
const tokens = (source: string) =>
  source.match(
    /\$\((?:[^()'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*"|\([^()]*\))*\)|(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|\$\{\w+\}|[^\s;&|(){}<>"'\\])+|&&|\|\||[;\n&|(){}]|\d*(?:>>?|<)(?:&\d+)?/g,
  ) ?? [];
const unquote = (word: string, variables: Map<string, string>) =>
  word.replace(
    /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)|([^'"\\]+)/g,
    (
      _part,
      single: string | undefined,
      double: string | undefined,
      escaped: string | undefined,
      plain: string | undefined,
    ) => {
      if (single !== undefined) return single;
      if (escaped !== undefined) return escaped;
      return (double ?? plain ?? "").replace(
        /\\(["\\$])|\$(?:\{(\w+)\}|(\w+))/g,
        (ref, escaped: string | undefined, braced: string | undefined, bare: string | undefined) =>
          escaped ?? variables.get(braced ?? bare ?? "") ?? ref,
      );
    },
  );

function unwrap(words: string[]) {
  while (words.length) {
    if (/^\w+=/.test(words[0]!)) {
      words.shift();
      continue;
    }
    const name = executable(words[0]);
    if (
      ![
        "env",
        "sudo",
        "command",
        "nohup",
        "exec",
        "time",
        "caffeinate",
        "timeout",
        "nice",
      ].includes(name)
    )
      break;
    words.shift();
    const takesValue: Record<string, RegExp> = {
      env: /^(?:-u|--unset|-C|--chdir)$/,
      sudo: /^(?:-[ughpCT]|--user|--group|--host|--prompt)$/,
      caffeinate: /^-[tw]$/,
      timeout: /^(?:-[sk]|--signal|--kill-after)$/,
      nice: /^(?:-n|--adjustment)$/,
    };
    while (words[0]?.startsWith("-")) {
      const option = words.shift()!;
      if (option === "--") break;
      if (takesValue[name]?.test(option)) words.shift();
    }
    if (name === "timeout") words.shift();
  }
  return words;
}

/** Only explicit process-launch APIs are programs; Python prints, strings and comments are data. */
function scriptInvocations(
  script: string,
  remote: boolean,
  variables: Map<string, string>,
): ShellInvocation[] {
  const actions: ShellInvocation[] = [];
  const launch =
    /^(?:(?:subprocess\.(?:run|Popen|call|check_call|check_output)|os\.(?:system|popen)|(?:child_process\.)?(?:execSync|exec|spawnSync|spawn))\s*\()/;
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (char === "#" || script.slice(i, i + 2) === "//") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? script.length : end;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      while (++i < script.length) {
        if (script[i] === "\\") i++;
        else if (script[i] === quote) break;
      }
      continue;
    }
    const match = launch.exec(script.slice(i));
    if (!match) continue;
    i += match[0].length;
    const rest = script.slice(i).trimStart();
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      const args = rest.slice(1, end).match(/'[^']*'|"(?:\\.|[^"\\])*"/g) ?? [];
      // Quote each argv item again: a data argument must not become a shell separator.
      actions.push(
        ...shellInvocations(
          args.map((arg) => `'${unquote(arg, variables).replaceAll("'", "'\\''")}'`).join(" "),
          new Map(variables),
          remote,
        ),
      );
    } else {
      const arg = rest.match(/^(?:'[^']*'|"(?:\\.|[^"\\])*")/)?.[0];
      if (arg)
        actions.push(...shellInvocations(unquote(arg, variables), new Map(variables), remote));
    }
  }
  return actions;
}

/** Shared by raw-UI, recording and failure grading. Literal aliases may span shell calls. */
export function shellInvocations(
  command: string,
  variables = new Map<string, string>(),
  remote = false,
): ShellInvocation[] {
  const bodies = new Map<string, { text: string; expand: boolean }>();
  command = command.replace(
    /^([^\n]*?)<<(-?)\s*(['"]?)(\w+)\3([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\4[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm,
    (
      _match,
      line: string,
      strip: string,
      quote: string,
      _end: string,
      rest: string,
      body: string,
    ) => {
      const key = `__HEREDOC_${bodies.size}`;
      bodies.set(key, { text: strip ? body.replace(/^\t+/gm, "") : body, expand: !quote });
      return `${line} ${key} ${rest}`;
    },
  );
  const actions: ShellInvocation[] = [];
  let clause: string[] = [];
  let pipe: string | undefined;
  let afterSuccess = false;
  const conditions: Array<{ parent: boolean; take: boolean | undefined }> = [];
  let active = true;
  const substitutions = (source: string, heredoc = false) => {
    const expanded = heredoc
      ? source
      : source.replace(
          /"((?:\\.|[^"\\])*)"|'[^']*'|\\./g,
          (part, double: string | undefined) => double ?? (part.startsWith("'") ? "" : part),
        );
    for (const match of expanded.matchAll(/(?<!\\)\$\(((?:[^()]|\([^()]*\))*)\)/g))
      actions.push(...shellInvocations(match[1]!, new Map(variables), remote));
  };
  const flush = () => {
    if (!clause.length) return;
    const rawWords = clause;
    clause = [];
    let words = rawWords.map((word) => unquote(word, variables));
    if (words[0] === "if") {
      const parent = active;
      conditions.push({
        parent,
        take: words[1] === "true" ? true : words[1] === "false" ? false : undefined,
      });
      const condition = words[1];
      words.shift();
      if (condition === "false" || condition === "true") return;
    }
    if (words[0] === "then") {
      active = conditions.at(-1)?.parent !== false && conditions.at(-1)?.take !== false;
      words.shift();
    }
    if (words[0] === "else") {
      const condition = conditions.at(-1);
      active = !!condition?.parent && condition.take !== true;
      words.shift();
    }
    if (words[0] === "fi") {
      active = conditions.pop()?.parent ?? true;
      words.shift();
    }
    if (words[0] === "elif") {
      // Any elif branch may run, so inspect them all.
      const condition = conditions.at(-1);
      active = condition?.parent ?? true;
      if (condition) condition.take = undefined;
      words.shift();
    }
    // Loop keywords and `!` run the command they introduce; a `for` list only expands.
    while (/^(?:while|until|do|done|!)$/.test(words[0] ?? "")) words.shift();
    const loopList = /^(?:for|select)$/.test(words[0] ?? "");
    if (!active || !words.length) return;
    for (const word of rawWords) if (!bodies.has(word)) substitutions(word);
    if (loopList) return;
    const body = words.map((word) => bodies.get(word)).find((value) => value !== undefined);
    if (body?.expand) substitutions(body.text, true);
    words = words.filter((word) => !bodies.has(word));
    const literalAssignments = words.every((word) => /^\w+=/.test(word));
    if (literalAssignments || words[0] === "export") {
      for (const word of words) {
        const at = word.indexOf("=");
        if (at > 0) variables.set(word.slice(0, at), word.slice(at + 1));
      }
      return;
    }
    if (executable(words[0]) === "command" && /^-[vV]$/.test(words[1] ?? "")) return;
    words = unwrap(words);
    const name = executable(words[0]);
    let input = body?.text ?? pipe;
    pipe = undefined;
    if (name === "cat" || name === "tee") {
      pipe = input;
      return;
    }
    if (name === "printf" || name === "echo") {
      pipe =
        name === "echo"
          ? words.slice(1).join(" ")
          : words[1]?.includes("%s")
            ? words.slice(2).join("\n")
            : words[1]?.replaceAll("\\n", "\n");
      return;
    }
    if (name === "ssh") {
      let at = 1;
      while (words[at]?.startsWith("-")) {
        const option = words[at++]!;
        if (option === "--") break;
        if (/^-[bBcDEeFIiJLlmOoPpQRSWw]$/.test(option)) at++;
      }
      at++; // destination
      if (words[at] === "--") at++;
      const script = words.slice(at).join(" ");
      // A remote shell/interpreter inherits redirected/piped stdin, never the local aliases.
      const destination = unwrap(tokens(script).map((word) => unquote(word, new Map())));
      const reader = executable(destination[0]);
      if (input !== undefined && (shells.has(reader) || interpreter.test(reader))) {
        if (interpreter.test(reader)) actions.push(...scriptInvocations(input, true, new Map()));
        else actions.push(...shellInvocations(input, new Map(), true));
      }
      actions.push(...shellInvocations(script, new Map(), true));
      return;
    }
    if (shells.has(name) || interpreter.test(name)) {
      const at = words.findIndex((word) => /^-[a-z]*[ce][a-z]*$/.test(word));
      if (at >= 0) input = words[at + 1];
      if (input !== undefined)
        actions.push(
          ...(shells.has(name)
            ? shellInvocations(input, new Map(variables), remote)
            : scriptInvocations(input, remote, variables)),
        );
      return;
    }
    if (words.includes("--help") || words[1] === "help") return;
    const normalized = name === "xcrun" ? words.slice(1) : words;
    const cli = executable(normalized[0]);
    const agent =
      ["agent-device", "mac_agent_device"].includes(cli) &&
      managedUi.test(deviceArgs(normalized)[0] ?? "");
    actions.push({
      words,
      remote,
      afterSuccess,
      raw:
        uiCommand.test([cli, ...normalized.slice(1)].join(" ")) ||
        (agent && (remote || cli === "mac_agent_device")),
      managed: agent && !remote && cli === "agent-device",
    });
  };
  const scopes: Array<Map<string, string>> = [];
  let comment = false;
  let redirect = false;
  for (const token of tokens(command.replace(/(^|\n)[ \t]*#[^\n]*/g, "$1"))) {
    if (token === "\n") comment = false;
    if (comment) continue;
    if (token.startsWith("#")) {
      comment = true;
      continue;
    }
    if (/^\d*(?:>>?|<)(?:&\d+)?$/.test(token)) {
      redirect = !token.includes("&");
      continue;
    }
    if (redirect) {
      redirect = false;
      continue;
    }
    if (/^(?:&&|\|\||[;\n&|(){}])$/.test(token)) {
      flush();
      if (token === "(") {
        scopes.push(variables);
        variables = new Map(variables);
      }
      if (token === ")") variables = scopes.pop() ?? variables;
      if (token !== "|") pipe = undefined;
      afterSuccess = token === "&&";
    } else clause.push(token);
  }
  flush();
  return actions;
}

const terminalText = (run: DeviceRun) => {
  if (run.finalText !== undefined) return run.finalText;
  if (run.transcript !== undefined) {
    const last = run.transcript.filter(record).at(-1);
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return "";
    return last.content
      .filter(record)
      .filter((block) => ["text", "output_text"].includes(String(block.type)))
      .map((block) => block.text)
      .join("\n");
  }
  // Compatibility with synthetic unit fixtures; retained runs have transcripts.
  return run.text ?? "";
};

export function gradeDevice(expect: typeof DeviceExpect.Type | undefined, run: DeviceRun) {
  const checks: Array<{ check: string; pass: boolean }> = [];
  if (!expect) return checks;
  if (expect.briefs !== undefined) {
    const briefs = run.calls.filter((call) =>
      ["delegate_task", "t3_thread_launch"].includes(call.tool),
    );
    checks.push({ check: "device briefs count", pass: briefs.length >= expect.briefs });
    for (const [i, call] of briefs.entries()) {
      const route = briefRoute(
        inputString(call.input, call.tool === "delegate_task" ? "task" : "message"),
      );
      checks.push({
        check: `device brief ${i + 1} ${call.tool} ${route}`,
        pass: route === "managed",
      });
    }
  }
  const variables = new Map<string, string>();
  const shell = run.calls
    .filter((call) => ["Bash", "Monitor"].includes(call.tool))
    .map((call) => ({
      call,
      actions: shellInvocations(inputString(call.input, "command"), variables),
    }));
  if (expect.noRawUi)
    checks.push({
      check: "shellMustNot device UI",
      pass: !shell.some(({ actions }) => actions.some((action) => action.raw)),
    });
  if (expect.capture) {
    const opened = run.calls.filter(
      (call) =>
        call.tool === "device_open" &&
        call.failed === false &&
        inputString(call.input, "hostId") === expect.capture?.hostId &&
        inputString(call.input, "deviceId") === expect.capture?.deviceId,
    );
    const capture =
      run.calls.some(
        (call) =>
          call.tool === "device_screenshot" &&
          (!inputString(call.input, "hostId") ||
            inputString(call.input, "hostId") === expect.capture?.hostId) &&
          (!inputString(call.input, "deviceId") ||
            inputString(call.input, "deviceId") === expect.capture?.deviceId) &&
          opened.some((open) => run.calls.indexOf(open) < run.calls.indexOf(call)),
      ) ||
      shell.some(
        ({ call, actions }) =>
          opened.some((open) => run.calls.indexOf(open) < run.calls.indexOf(call)) &&
          actions.some(
            (action) =>
              action.managed &&
              (run.launchers ?? []).includes(action.words[0] ?? "") &&
              ["screenshot", "snapshot", "record"].includes(deviceArgs(action.words)[0] ?? ""),
          ),
      );
    checks.push({
      check: "device successful open and capture attempt",
      pass: opened.length > 0 && capture,
    });
  }
  if (expect.recording !== undefined) {
    const steps = shell
      .filter(({ call }) => call.failed === false)
      .flatMap(({ actions }) =>
        actions
          .filter(
            (action) => !action.remote && (run.launchers ?? []).includes(action.words[0] ?? ""),
          )
          .flatMap((action) => {
            const args = deviceArgs(action.words);
            const operation = args[0] === "record" ? args[1] : "";
            return operation === "start" || operation === "stop" ? [operation] : [];
          }),
      );
    const start = steps.indexOf("start");
    checks.push({
      check: `device recording ${expect.recording}`,
      pass:
        start >= 0 &&
        steps.indexOf("stop", start + 1) >= 0 &&
        run.stopReason === "end_turn" &&
        terminalText(run).includes(expect.recording),
    });
  }
  if (expect.maxFailedAttemptsPerTurn !== undefined) {
    const failedByTurn = new Map<number, number>();
    for (const call of run.calls) {
      if (!call.failed) continue;
      const actions = shell.find((entry) => entry.call === call)?.actions ?? [];
      const attempts = call.tool.startsWith("device_")
        ? 1
        : actions.filter((action) => action.managed && !action.afterSuccess).length;
      const turn = call.turn ?? 0;
      failedByTurn.set(turn, (failedByTurn.get(turn) ?? 0) + attempts);
    }
    const max = expect.maxFailedAttemptsPerTurn;
    checks.push({
      check: `maxCalls device failures per user turn <= ${max}`,
      pass: [...failedByTurn.values()].every((count) => count <= max),
    });
  }
  return checks;
}

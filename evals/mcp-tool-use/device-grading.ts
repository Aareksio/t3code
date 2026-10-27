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
    readonly output?: string;
  }>;
};
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const inputString = (input: unknown, key: string) =>
  record(input) && typeof input[key] === "string" ? input[key] : "";
/**
 * The device a `device_screenshot` call reached: the device in T3's result, else its input.
 * Which host an omitted `hostId` means depends on the ref, so only a result settles it; without
 * one it is `local`, as on main.
 */
const screenshotTarget = (call: DeviceRun["calls"][number]) => {
  try {
    const device: unknown = JSON.parse(call.output ?? "").device;
    if (record(device) && typeof device.hostId === "string" && typeof device.id === "string")
      return { hostId: device.hostId, deviceId: device.id };
  } catch {}
  return {
    hostId: inputString(call.input, "hostId") || "local",
    deviceId: inputString(call.input, "deviceId"),
  };
};
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
    .replace(/\b(?:do not|don't)\s+forget\s+to\b/g, "")
    .replace(/\b(?:do not|don't)\s+avoid\b/g, "use")
    .replace(/\b(?:should|must)\s+not\s+be\s+avoided\b/g, "is allowed")
    .replace(/\b(?:there is )?no need to avoid\b/g, "use")
    .replace(/\bnot just\b/g, "")
    .replace(/\bbut (?:also )?for\b/g, "and for")
    .replace(/\bavoid limiting (ssh|simctl|adb|idb) to [^.;]+;\s*use it\b/g, "use $1")
    .replace(/(^|[.!;\n]\s*)(for [^.;,\n]+),\s*(?=(?:use|run)\b)/g, "$1$2 ")
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
        .replace(/\b(?:record|capture|stream)\s+(?:the\s+)?logs\b/g, "logs")
        .replace(/\b(?:logs? from|reading)\s+screenshot\s+(?:tests?|logs?)\b/g, "logs")
        .replace(
          /\b(?:copy(?:ing)?|fetch(?:ing)?|transfer(?:ring)?|download(?:ing)?|sync(?:ing)?)\s+(?:(?:the|already|saved)\s+)*(?:screenshots?|recordings?|artifacts?)\b/g,
          "artifact transfer",
        ),
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
      const hostPurpose =
        /^\s+(?:-\S+\s+\S+\s+)*\S+\s+(?:for|and|then)\b|^\s+(?:handles|and|then)\b/.test(after);
      if ((purpose || hostPurpose || new RegExp(`^\\s+${ui.source}`).test(after)) && ui.test(after))
        return true;
      const via = new RegExp(
        `${ui.source}(?:\\s+(?:may|can|must|should|be|is|are|taken|captured|saved|recorded|only|directly))*\\s+(?:via|by|over|through|using|with|use|run)\\s+(?:raw\\s+)?$`,
      );
      if (
        via.test(before) ||
        /\b(?:screenshots?|screen(?: capture)?|recordings?)(?:\s+on\s+\S+)?\s+(?:over|via|using|through|with)\s*$/.test(
          before,
        ) ||
        /\bfor\s+[^.;]*\b(?:screenshots?|recordings?|screen capture)\s*,?\s*$/.test(before)
      )
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
    if (word === "--") {
      args.push(...words.slice(i + 1));
      break;
    }
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
/** How agent-device reports a failed command, e.g. `Error (COMMAND_FAILED): …`. */
const AGENT_DEVICE_ERROR = /\bError \([A-Z_]+\):/;

export type ShellInvocation = {
  readonly words: ReadonlyArray<string>;
  readonly remote: boolean;
  readonly raw: boolean;
  readonly managed: boolean;
  /** Raw-route checks inspect possible actions; managed credit requires established execution. */
  readonly executed: boolean;
  /** An aggregate success cannot establish success of an action masked by ||. */
  readonly unmasked: boolean;
  /** A later `;` or `&` command owns the call's exit status. */
  readonly sequenced: boolean;
};

// A deliberately bounded shell grammar, not a shell executor. Keep quotes until expansion so
// literal command examples, comments and quoted heredocs never become invocations.
const tokens = (source: string) =>
  source
    .replace(/'[^']*'|\\\n/g, (part) => (part.startsWith("'") ? part : ""))
    .match(
      /`(?:\\.|[^`])*`|[<>]\((?:[^()]|\([^()]*\))*\)|\$\((?:[^()'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*"|\([^()]*\))*\)|(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|\$\{\w+\}|[^\s;&|(){}<>"'\\])+|&&|\|\||[;\n&|(){}]|\d*(?:>>?|<)(?:&\d+)?/g,
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

/** Literal process-launch APIs only. Definitions and strings are not executed programs. */
function scriptInvocations(
  script: string,
  remote: boolean,
  variables: Map<string, string>,
  language: string,
): ShellInvocation[] {
  const actions: ShellInvocation[] = [];
  const python = language.startsWith("python");
  // A function body is source, not an invocation. Calls to computed/script functions are
  // outside this grammar; do not grant managed credit for them.
  let definitionIndent: number | undefined;
  if (python)
    script = script
      .split("\n")
      .map((line) => {
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (line.trim() && definitionIndent !== undefined && indent <= definitionIndent)
          definitionIndent = undefined;
        if (/^\s*(?:async\s+)?def\s/.test(line)) definitionIndent = indent;
        return definitionIndent === undefined ? line : "";
      })
      .join("\n");
  const launch =
    /^(subprocess\.(?:run|Popen|call|check_call|check_output)|os\.(?:system|popen)|(?:child_process\.)?(?:execFileSync|execFile|execSync|exec|spawnSync|spawn))\s*\(/;
  const literal = "(?:'[^']*'|\"(?:\\\\.|[^\"\\\\])*\")";
  const quoteArg = (arg: string) => `'${unquote(arg, variables).replaceAll("'", "'\\''")}'`;
  const array = (source: string) => {
    const match = new RegExp(`^\\[\\s*(${literal}(?:\\s*,\\s*${literal})*\\s*,?)?\\s*\\]`).exec(
      source,
    );
    return match
      ? (match[1]?.match(new RegExp(literal, "g")) ?? []).map(quoteArg).join(" ")
      : undefined;
  };
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (char === "#" || script.slice(i, i + 2) === "//") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? script.length : end;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = python && script.slice(i, i + 3) === char.repeat(3) ? char.repeat(3) : char;
      i += quote.length;
      while (i < script.length && script.slice(i, i + quote.length) !== quote) {
        if (script[i] === "\\") i++;
        i++;
      }
      i += quote.length - 1;
      continue;
    }
    const match = launch.exec(script.slice(i));
    if (!match) continue;
    const rest = script.slice(i + match[0].length).trimStart();
    let program: string | undefined;
    if (rest.startsWith("[")) program = array(rest);
    else {
      const arg = rest.match(new RegExp(`^${literal}`))?.[0];
      const tail = arg === undefined ? "" : rest.slice(arg.length);
      if (arg && /(?:spawn|execFile)/.test(match[1]!)) {
        const argv = array(tail.replace(/^\s*,\s*/, ""));
        if (argv !== undefined) program = `${quoteArg(arg)} ${argv}`;
      } else if (
        arg &&
        (!python || match[1]!.startsWith("os.") || /^\s*,[^)]*\bshell\s*=\s*True\b/.test(tail))
      ) {
        program = unquote(arg, variables);
      }
    }
    if (program !== undefined) {
      const line = script.slice(script.lastIndexOf("\n", i) + 1, i);
      const certain = python ? !/^\s/.test(line) : !script.slice(0, i).includes("{");
      actions.push(
        ...shellInvocations(program, new Map(variables), remote).map((action) => ({
          ...action,
          executed: action.executed && certain,
        })),
      );
    }
    i += match[0].length - 1;
  }
  return actions;
}

/** Shared by raw-UI, recording and failure grading. Literal aliases may span shell calls. */
export function shellInvocations(
  command: string,
  variables = new Map<string, string>(),
  remote = false,
  succeeded = false,
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
  let gate = "";
  let status: boolean | undefined;
  const conditions: Array<{ parent: boolean; certain: boolean; take: boolean | undefined }> = [];
  let active = true;
  let certain = true;
  let currentCertain = true;
  let currentUnmasked = true;
  let currentSequenced = false;
  const append = (nested: ShellInvocation[]) =>
    actions.push(
      ...nested.map((action) => ({
        ...action,
        executed: action.executed && currentCertain,
        unmasked: action.unmasked && currentUnmasked,
        sequenced: action.sequenced || currentSequenced,
      })),
    );
  const truth = (words: string[]): boolean | undefined => {
    if (words[0] === "!") {
      const value = truth(words.slice(1));
      return value === undefined ? undefined : !value;
    }
    return ["true", ":"].includes(words[0] ?? "") ? true : words[0] === "false" ? false : undefined;
  };
  const commandTokens = tokens(command.replace(/(^|\n)[ \t]*#[^\n]*/g, "$1"));
  let tokenIndex = 0;
  const functions = new Map<string, { text: string; certain: boolean }>();
  const listTokens = () => {
    let start = tokenIndex - 1,
      end = tokenIndex;
    while (start >= 0 && !/^[;\n&]$/.test(commandTokens[start]!)) start--;
    while (end < commandTokens.length && !/^[;\n&]$/.test(commandTokens[end]!)) end++;
    return commandTokens.slice(start + 1, end);
  };
  const substitutions = (source: string, heredoc = false) => {
    const expanded = heredoc
      ? source
      : source.replace(
          /"((?:\\.|[^"\\])*)"|'[^']*'|\\./g,
          (part, double: string | undefined) => double ?? (part.startsWith("'") ? "" : part),
        );
    for (const match of expanded.matchAll(/(?<!\\)\$\(((?:[^()]|\([^()]*\))*)\)/g))
      append(shellInvocations(match[1]!, new Map(variables), remote));
    for (const match of expanded.matchAll(/(?<!\\)`([^`]*)`|[<>]\(((?:[^()]|\([^()]*\))*)\)/g))
      append(shellInvocations(match[1] ?? match[2]!, new Map(variables), remote));
  };
  const flush = () => {
    if (!clause.length) return;
    const rawWords = clause;
    const redirects = redirectOperands;
    redirectOperands = [];
    clause = [];
    let words = rawWords.map((word) => unquote(word, variables));
    if (words[0] === "if") {
      const parent = active;
      conditions.push({
        parent,
        certain,
        take: truth(words.slice(1)),
      });
      words.shift();
    }
    if (words[0] === "then") {
      const condition = conditions.at(-1);
      active = condition?.parent !== false && condition?.take !== false;
      certain = condition?.certain !== false && condition?.take === true;
      words.shift();
    }
    if (words[0] === "else") {
      const condition = conditions.at(-1);
      active = !!condition?.parent && condition.take !== true;
      certain = !!condition?.certain && condition.take === false;
      words.shift();
    }
    if (words[0] === "fi") {
      const condition = conditions.pop();
      active = condition?.parent ?? true;
      certain = condition?.certain ?? true;
      words.shift();
    }
    if (words[0] === "elif") {
      // Any elif branch may run, so inspect them all.
      const condition = conditions.at(-1);
      active = condition?.parent ?? true;
      certain = false;
      if (condition) condition.take = undefined;
      words.shift();
    }
    const loopList = /^(?:for|select)$/.test(words[0] ?? "");
    if (/^(?:while|until)$/.test(words[0] ?? "") || loopList) {
      const value = loopList
        ? words[2] === "in" && words.length > 3
          ? true
          : undefined
        : truth(words.slice(1));
      conditions.push({
        parent: active,
        certain,
        take: words[0] === "until" && value !== undefined ? !value : value,
      });
      if (!loopList) words.shift();
    }
    if (words[0] === "do") {
      const condition = conditions.at(-1);
      active = condition?.parent !== false && condition?.take !== false;
      certain = condition?.certain !== false && condition?.take === true;
      words.shift();
    }
    if (words[0] === "done") {
      const condition = conditions.pop();
      active = condition?.parent ?? true;
      certain = condition?.certain ?? true;
      words.shift();
    }
    const reachable =
      gate === "&&" ? status : gate === "||" ? (status === undefined ? undefined : !status) : true;
    if (!active || !words.length || reachable === false) return;
    const list = listTokens();
    currentUnmasked = !list.includes("||") && words[0] !== "!";
    // The call's exit status is the last command's; an action followed by `;` or `&` doesn't own it.
    currentSequenced = commandTokens.slice(tokenIndex).some((t) => /^[;\n&]$/.test(t));
    const finalAndSuccess =
      succeeded &&
      gate === "&&" &&
      currentUnmasked &&
      !commandTokens.some((t) => /^(?:if|for|while|until|then|else|fi|do|done)$/.test(t)) &&
      !commandTokens.slice(tokenIndex).some((t) => /^[;\n&]$/.test(t));
    currentCertain = certain && (reachable === true || finalAndSuccess);
    // A list's status is known only when this command certainly ran, or when its own result
    // decides the list either way (`x && false`, `x || true`).
    const value = truth(words);
    status =
      reachable === true
        ? value
        : gate === "&&" && value === false
          ? false
          : gate === "||" && value === true
            ? true
            : undefined;
    for (const word of [...rawWords, ...redirects]) if (!bodies.has(word)) substitutions(word);
    if (loopList) return;
    const body = words.map((word) => bodies.get(word)).find((value) => value !== undefined);
    if (body?.expand) substitutions(body.text, true);
    words = words.filter((word) => !bodies.has(word));
    const literalAssignments = words.every((word) => /^\w+=/.test(word));
    if (literalAssignments || words[0] === "export") {
      for (const word of words) {
        const at = word.indexOf("=");
        if (at > 0) {
          if (currentCertain) variables.set(word.slice(0, at), word.slice(at + 1));
          else variables.delete(word.slice(0, at));
        }
      }
      return;
    }
    if (executable(words[0]) === "command" && /^-[vV]$/.test(words[1] ?? "")) return;
    while (words[0] === "!") words.shift();
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
    if (functions.has(name)) {
      const definition = functions.get(name)!;
      append(
        shellInvocations(definition.text, new Map(variables), remote, succeeded).map((action) => ({
          ...action,
          executed: action.executed && definition.certain,
        })),
      );
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
      const hasProgram = destination.some((word) => /^-[a-z]*[ce][a-z]*$/.test(word));
      if (
        input !== undefined &&
        (!reader || ((shells.has(reader) || interpreter.test(reader)) && !hasProgram))
      ) {
        if (interpreter.test(reader)) append(scriptInvocations(input, true, new Map(), reader));
        else append(shellInvocations(input, new Map(), true));
      }
      append(shellInvocations(script, new Map(), true));
      return;
    }
    if (shells.has(name) || interpreter.test(name)) {
      const at = words.findIndex((word) => /^-[a-z]*[ce][a-z]*$/.test(word));
      if (at >= 0) input = words[at + 1];
      if (input !== undefined)
        append(
          shells.has(name)
            ? shellInvocations(input, new Map(variables), remote, succeeded)
            : scriptInvocations(input, remote, variables, name),
        );
      return;
    }
    const endOptions = words.indexOf("--");
    if (
      words
        .slice(0, endOptions < 0 ? words.length : endOptions)
        .some((word) => word === "--help" || word === "-h") ||
      words[1] === "help"
    )
      return;
    const normalized = name === "xcrun" ? words.slice(1) : [...words];
    if (name === "xcrun")
      while (normalized[0]?.startsWith("-")) {
        const option = normalized.shift();
        if (/^(?:--sdk|-sdk|--toolchain|-toolchain)$/.test(option ?? "")) normalized.shift();
      }
    const cli = executable(normalized[0]);
    const agent =
      ["agent-device", "mac_agent_device"].includes(cli) &&
      managedUi.test(deviceArgs(normalized)[0] ?? "");
    actions.push({
      words,
      remote,
      executed: currentCertain,
      unmasked: currentUnmasked,
      sequenced: currentSequenced,
      raw:
        uiCommand.test([cli, ...normalized.slice(1)].join(" ")) ||
        (agent && (remote || cli === "mac_agent_device")),
      managed: agent && !remote && cli === "agent-device",
    });
  };
  const scopes: Array<{ variables: Map<string, string>; active: boolean; certain: boolean }> = [];
  let comment = false;
  let redirect = false;
  let redirectOperands: string[] = [];
  for (; tokenIndex < commandTokens.length; tokenIndex++) {
    const token = commandTokens[tokenIndex]!;
    // Shell function definitions don't execute their bodies. Keep literal calls supported.
    const nameAt = tokenIndex + (token === "function" ? 1 : 0);
    const bodyAt =
      commandTokens[nameAt + 1] === "(" && commandTokens[nameAt + 2] === ")"
        ? nameAt + 3
        : token === "function"
          ? nameAt + 1
          : -1;
    if (commandTokens[bodyAt] === "{") {
      flush();
      let end = bodyAt + 1,
        depth = 1;
      for (; end < commandTokens.length && depth; end++) {
        if (commandTokens[end] === "{") depth++;
        if (commandTokens[end] === "}") depth--;
      }
      if (active)
        functions.set(commandTokens[nameAt]!, {
          text: commandTokens.slice(bodyAt + 1, end - 1).join(" "),
          certain,
        });
      tokenIndex = end - 1;
      continue;
    }
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
      redirectOperands.push(token);
      continue;
    }
    if (/^(?:&&|\|\||[;\n&|(){}])$/.test(token)) {
      flush();
      if (token === "(" || token === "{") {
        scopes.push({ variables, active, certain });
        if (token === "(") variables = new Map(variables);
        const reachable =
          gate === "&&"
            ? status
            : gate === "||"
              ? status === undefined
                ? undefined
                : !status
              : true;
        active = active && reachable !== false;
        certain = certain && reachable === true;
      }
      if (token === ")" || token === "}") {
        const scope = scopes.pop();
        if (scope) ({ variables, active, certain } = scope);
      }
      if (token !== "|") pipe = undefined;
      gate = token;
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
      actions: shellInvocations(
        inputString(call.input, "command"),
        variables,
        false,
        call.failed === false,
      ),
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
      run.calls.some((call) => {
        if (call.tool !== "device_screenshot") return false;
        const target = screenshotTarget(call);
        return (
          target.hostId === expect.capture?.hostId &&
          (!target.deviceId || target.deviceId === expect.capture?.deviceId) &&
          opened.some((open) => run.calls.indexOf(open) < run.calls.indexOf(call))
        );
      }) ||
      shell.some(
        ({ call, actions }) =>
          opened.some((open) => run.calls.indexOf(open) < run.calls.indexOf(call)) &&
          actions.some(
            (action) =>
              action.executed &&
              action.managed &&
              (run.launchers ?? []).includes(action.words[0] ?? "") &&
              (["screenshot", "snapshot"].includes(deviceArgs(action.words)[0] ?? "") ||
                (deviceArgs(action.words)[0] === "record" &&
                  deviceArgs(action.words)[1] === "start")),
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
      .flatMap(({ call, actions }) =>
        actions
          .filter(
            (action) =>
              action.executed &&
              action.unmasked &&
              // Before a later `;` command, only an error-free output shows the action succeeded.
              (!action.sequenced || !AGENT_DEVICE_ERROR.test(call.output ?? "")) &&
              !action.remote &&
              (run.launchers ?? []).includes(action.words[0] ?? ""),
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
        : Number(actions.some((action) => action.managed));
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

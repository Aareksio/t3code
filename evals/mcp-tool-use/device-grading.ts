import * as Schema from "effect/Schema";

export const DeviceExpect = Schema.Struct({
  briefs: Schema.optional(Schema.Number),
  recording: Schema.optional(Schema.String),
  noRawUi: Schema.optional(Schema.Boolean),
  maxFailedAttemptsPerTurn: Schema.optional(Schema.Number),
});

type DeviceRun = {
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
    .replace(/\b(for [^.;,\n]+),\s*(?=(?:use|run)\b)/g, "$1 ")
    .split(
      /[\n.!;]+(?=\s|$)|\b(?:but|however)\b|(?:,\s*|\band\s+|\bthen\s+)(?=(?:use|run|call|drive|capture|take|inspect|save)\b)/,
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
      const purpose =
        /^\s+(?:(?:is|are|can|may|must|should|be|used|only|allowed|permitted|fine)\s+)*(?:for|to|into)\b/.test(
          after,
        );
      if ((purpose || new RegExp(`^\\s+${ui.source}`).test(after)) && ui.test(after)) return true;
      const via = new RegExp(
        `${ui.source}(?:\\s+(?:may|can|must|should|be|is|are|taken|captured|saved|recorded|only|directly))*\\s+(?:via|over|through|using|with|use|run)\\s+(?:raw\\s+)?$`,
      );
      if (via.test(before)) return true;
    }
    return false;
  });
  return hasManaged && hasRaw ? "mixed" : hasManaged ? "managed" : hasRaw ? "raw" : "neutral";
}

const words = (command: string) =>
  (command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n]|[^\s;&|]+/g) ?? []).map((word) =>
    /^['"]/.test(word) ? word.slice(1, -1).replace(/\\(["\\])/g, "$1") : word,
  );
const executable = (word = "") => word.split("/").at(-1) ?? "";
const uiCommand =
  /^(?:simctl\s+(?:launch|terminate|openurl|ui|privacy|location|push)\b|simctl\s+io\s+\S+\s+(?:screenshot|recordvideo)\b|idb\b.*\b(?:ui|screenshot|launch|video|record)\b|adb\b.*\b(?:shell\s+(?:input|am\s+start|settings)|(?:shell|exec-out)\s+(?:screencap|screenrecord))\b|screencapture\b|lab-(?:shot|ui|launch|capture(?:-set)?)\b)/i;
const managedUi =
  /\b(?:snapshot|screenshot|record|open|close|tap|click|type|fill|press|swipe|scroll|settings|back|home)\b/;
// Simulator UI inside a Python, Node, Ruby, Perl or AppleScript program, with its quotes and
// list punctuation flattened: `subprocess.run(['xcrun', 'simctl', 'io', id, 'recordVideo'])`.
const interpreter = /^(?:python\d*(?:\.\d+)?|node|ruby|perl|osascript)$/;
const scriptUi = (script: string) =>
  /\bsimctl\s+(?:launch|terminate|openurl|ui|privacy|location|push)\b|\bsimctl\s+io\s+\S+\s+(?:screenshot|recordvideo)\b|\bidb\s+(?:ui|screenshot|launch|video|record)\b|\badb\b.*?\b(?:input|screencap|screenrecord)\b|\bscreencapture\b/i.test(
    script.replace(/[[\]'"(),]/g, " ").replace(/\s+/g, " "),
  );

function shellActions(command: string, remote = false): Array<{ raw: boolean; managed: boolean }> {
  // A heredoc body is a program only when a shell or an interpreter reads it; `cat > notes <<EOF` is data.
  const bodies: Array<{ raw: boolean; managed: boolean }> = [];
  command = command.replace(
    /^([^\n]*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\3[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm,
    (_match, line: string, _quote, _end, rest: string, body: string) => {
      const reader = words(line).flatMap((word) => word.split(/\s+/).map(executable));
      if (reader.some((word) => interpreter.test(word)))
        bodies.push({ raw: scriptUi(body), managed: false });
      else if (!reader.some((word) => ["cat", "tee"].includes(word)))
        bodies.push(...shellActions(body, remote || reader[0] === "ssh"));
      return line + rest;
    },
  );
  const clauses: string[][] = [[]];
  for (const word of words(command)) {
    if (/^(?:&&|\|\||[;|\n])$/.test(word)) clauses.push([]);
    else clauses.at(-1)!.push(word);
  }
  return [
    ...bodies,
    ...clauses.flatMap((clause) => {
      // Wrappers that run the next word: `nohup xcrun …`, `timeout 30 xcrun …`, `nice -n 5 xcrun …`.
      while (
        /^\w+=|^(?:env|sudo|command|nohup|exec|time|caffeinate|timeout|nice)$/.test(clause[0] ?? "")
      )
        if (/^(?:timeout|nice)$/.test(clause.shift()!))
          while (/^-|^[+-]?\d+(?:\.\d+)?[smhd]?$/.test(clause[0] ?? "")) clause.shift();
      const name = executable(clause[0]);
      if (interpreter.test(name)) {
        const at = clause.findIndex((word) => /^-[a-z]*[ce]$/.test(word));
        return at >= 0 ? [{ raw: scriptUi(clause[at + 1] ?? ""), managed: false }] : [];
      }
      if (name === "ssh") {
        let at = 1;
        while (clause[at]?.startsWith("-")) {
          const option = clause[at++]!;
          if (/^-[bBcDEeFIiJLlmOoPpQRSWw]$/.test(option)) at++;
        }
        return shellActions(clause.slice(at + 1).join(" "), true);
      }
      if (["bash", "sh", "zsh"].includes(name)) {
        const at = clause.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
        return at >= 0 ? shellActions(clause[at + 1] ?? "", remote) : [];
      }
      if (name === "xcrun") clause.shift();
      if (clause.includes("--help") || clause[1] === "help") return [];
      const cli = executable(clause[0]);
      const action = `${cli} ${clause.slice(1).join(" ")}`;
      const agent = ["agent-device", "mac_agent_device"].includes(cli) && managedUi.test(action);
      return [
        {
          raw: uiCommand.test(action) || (agent && (remote || cli === "mac_agent_device")),
          managed: agent && !remote && cli === "agent-device",
        },
      ];
    }),
  ];
}

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
  const shell = run.calls
    .filter((call) => ["Bash", "Monitor"].includes(call.tool))
    .map((call) => ({ call, actions: shellActions(inputString(call.input, "command")) }));
  if (expect.noRawUi)
    checks.push({
      check: "shellMustNot device UI",
      pass: !shell.some(({ actions }) => actions.some((action) => action.raw)),
    });
  if (expect.maxFailedAttemptsPerTurn !== undefined) {
    const failedByTurn = new Map<number, number>();
    for (const call of run.calls) {
      if (!call.failed) continue;
      if (
        !call.tool.startsWith("device_") &&
        !shell.some(
          (entry) => entry.call === call && entry.actions.some((action) => action.managed),
        )
      )
        continue;
      const turn = call.turn ?? 0;
      failedByTurn.set(turn, (failedByTurn.get(turn) ?? 0) + 1);
    }
    const max = expect.maxFailedAttemptsPerTurn;
    checks.push({
      check: `maxCalls device failures per user turn <= ${max}`,
      pass: [...failedByTurn.values()].every((count) => count <= max),
    });
  }
  return checks;
}

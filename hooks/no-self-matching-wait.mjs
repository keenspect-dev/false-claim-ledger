#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash).
//
// Refuses a shell wait loop whose `pgrep -f <pattern>` matches the loop's own
// command line. `pgrep -f` matches against full command lines, and the shell
// running the loop has the pattern in its own command line, so the check
// always finds itself and the loop never exits.
//
// Wiring (settings.json):
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash",
//       "hooks": [ { "type": "command", "command": "node /path/to/no-self-matching-wait.mjs" } ] } ] } }
//
// Output format: https://code.claude.com/docs/en/hooks (PreToolUse decision control).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// while|until <condition containing pgrep -f PATTERN> ; do
const LOOP = /\b(while|until)\b([^\n]*?)\bpgrep\s+(?:-[A-Za-z]*\s+)*?(?:-[A-Za-z]*f[A-Za-z]*|--full)\s+(?:-[A-Za-z]+\s+)*(?:'([^']*)'|"([^"]*)"|([^\s;|&)"']+))/g;

function unquote(m) {
  return m[3] ?? m[4] ?? m[5];
}

// Returns a reason string if the command contains a wait loop that can never exit.
export function inspect(command) {
  for (const m of command.matchAll(LOOP)) {
    const kind = m[1];
    const between = m[2];
    const pattern = unquote(m);
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      continue; // not a regex we can evaluate: allow rather than guess
    }
    if (!re.test(command)) continue; // e.g. the bracket trick: '[f]oo' does not match its own text
    const negated = /!\s*$/.test(between) || /-z\s+"?\$\(\s*$/.test(between);
    const hangs = kind === "while" ? !negated : negated;
    if (!hangs) continue;
    return (
      `This ${kind} loop polls \`pgrep -f ${pattern}\`, and "${pattern}" appears in this command's own text, ` +
      "so pgrep matches the shell running the loop and the loop never exits. " +
      "Write the pattern so it cannot match itself (for example '[f]oo' instead of 'foo'), " +
      "wait on a PID with `tail --pid` or `wait`, or poll a file or status instead."
    );
  }
  return null;
}

export function decide(input) {
  if (input?.tool_name !== "Bash") return null;
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return null;
  const reason = inspect(command);
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable input: do not block the tool
  }
  const out = decide(input);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

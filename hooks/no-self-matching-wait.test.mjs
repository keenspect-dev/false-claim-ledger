import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect, decide } from "./no-self-matching-wait.mjs";

const HOOK = fileURLToPath(new URL("./no-self-matching-wait.mjs", import.meta.url));
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("denies while-pgrep -f whose pattern is in its own text", () => {
  assert.ok(inspect("while pgrep -f build-worker; do sleep 5; done"));
  assert.ok(inspect("while pgrep -f 'build worker' >/dev/null; do sleep 5; done"));
  assert.ok(inspect('while pgrep -fl "build-worker"; do sleep 5; done'));
  assert.ok(inspect("while pgrep --full build-worker; do sleep 5; done"));
  assert.ok(inspect("until ! pgrep -f build-worker; do sleep 5; done"));
  assert.ok(inspect('while [ -n "$(pgrep -f build-worker)" ]; do sleep 5; done'));
});

test("allows patterns that cannot match their own text", () => {
  assert.equal(inspect("while pgrep -f '[b]uild-worker'; do sleep 5; done"), null);
});

test("allows loops that do not hang", () => {
  assert.equal(inspect("until pgrep -f build-worker; do sleep 1; done"), null); // wait-for-start exits at once
  assert.equal(inspect("while ! pgrep -f build-worker; do sleep 1; done"), null);
  assert.equal(inspect("while pgrep -x build-worker; do sleep 5; done"), null); // exact name, not full command line
  assert.equal(inspect("pgrep -f build-worker"), null); // no loop
  assert.equal(inspect("ls -la"), null);
});

test("decide: official PreToolUse deny shape, Bash only", () => {
  const out = decide(bash("while pgrep -f foo; do sleep 1; done"));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /never exits/);
  assert.equal(decide({ tool_name: "Read", tool_input: { command: "while pgrep -f foo; do :; done" } }), null);
  assert.equal(decide({ tool_name: "Bash", tool_input: {} }), null);
});

test("process: reads stdin, prints deny JSON, exit 0", () => {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(bash("while pgrep -f foo; do sleep 1; done")), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("process: allowed command prints nothing; garbage stdin does not block", () => {
  const ok = spawnSync("node", [HOOK], { input: JSON.stringify(bash("echo hi")), encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "");
  const bad = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
});

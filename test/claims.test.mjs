import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../bin/claims.mjs";
import { validateLedger, debt, ratchet } from "../lib/ledger.mjs";

const EXAMPLE = JSON.parse(readFileSync(new URL("../ledger/example-ledger.json", import.meta.url), "utf8"));
const clone = (x) => structuredClone(x);
const TODAY = "2025-03-31";

function run(args) {
  const o = [];
  const e = [];
  const rc = main(args, (s) => o.push(s), (s) => e.push(s));
  return { rc, out: o.join("\n"), err: e.join("\n") };
}
const tmp = () => mkdtempSync(join(tmpdir(), "claims-"));
const put = (dir, name, obj) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
};

const ADD = [
  "add", "--claim", "build is green", "--where", "chat", "--instrument", "CI re-run",
  "--result", "red", "--true-value", "build red", "--caught-by", "owner",
  "--category", "proxy-substitution", "--root-cause", "read a cached badge",
  "--retraction", "build was red", "--fix", "badge replaced by live status",
  "--allowance-days", "7", "--today", "2025-04-01",
];

test("example ledger is valid", () => {
  assert.deepEqual(validateLedger(EXAMPLE), []);
});

test("validation: missing required field", () => {
  const l = clone(EXAMPLE);
  delete l.claims[0].true_value;
  assert.match(validateLedger(l).join("\n"), /missing required "true_value"/);
});

test("validation: unknown field, empty string, bad date, wrong type", () => {
  const l = clone(EXAMPLE);
  l.claims[0].extra = 1;
  l.claims[1].claim = "";
  l.claims[2].stated_at = "last Tuesday";
  l.claims[3].durable_fix.allowance_days = "7";
  const errs = validateLedger(l).join("\n");
  assert.match(errs, /unknown field "extra"/);
  assert.match(errs, /claim: empty/);
  assert.match(errs, /stated_at: does not match/);
  assert.match(errs, /expected integer/);
});

test("validation: calendar-impossible date passes the pattern but is rejected", () => {
  const l = clone(EXAMPLE);
  l.claims[0].stated_at = "2025-02-30";
  assert.match(validateLedger(l).join("\n"), /not a real calendar date/);
});

test("validation: cross-field rules", () => {
  let l = clone(EXAMPLE);
  l.claims[1].durable_fix.landed = true; // no landed_at / evidence
  assert.match(validateLedger(l).join("\n"), /needs landed_at/);
  l = clone(EXAMPLE);
  l.claims[0].durable_fix.landed = false; // landed_at left behind
  assert.match(validateLedger(l).join("\n"), /landed=false/);
  l = clone(EXAMPLE);
  l.claims[1].id = "FC-001";
  assert.match(validateLedger(l).join("\n"), /duplicate id/);
  l = clone(EXAMPLE);
  l.claims[0].retraction.at = "2024-12-01";
  assert.match(validateLedger(l).join("\n"), /retraction predates/);
});

test("fail closed: unknown root-cause category is rejected", () => {
  const l = clone(EXAMPLE);
  l.claims[0].root_cause_category = "bad-luck";
  assert.match(validateLedger(l).join("\n"), /"bad-luck" not in \[/);
});

test("fail closed: add with unknown category writes nothing", () => {
  const dir = tmp();
  const ledger = join(dir, "l.json");
  const args = ADD.map((a) => (a === "proxy-substitution" ? "made-up-category" : a));
  const r = run([...args, "--ledger", ledger]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /not in \[/);
  assert.throws(() => readFileSync(ledger), /ENOENT/);
});

test("add creates a ledger, assigns ids, and is append-only", () => {
  const dir = tmp();
  const ledger = join(dir, "l.json");
  assert.equal(run([...ADD, "--ledger", ledger]).rc, 0);
  const r = run([...ADD, "--ledger", ledger]);
  assert.match(r.out, /recorded FC-002/);
  const saved = JSON.parse(readFileSync(ledger, "utf8"));
  assert.equal(saved.claims.length, 2);
  assert.equal(saved.claims[0].durable_fix.landed, false);
});

test("add with missing flags exits 2", () => {
  const r = run(["add", "--claim", "x", "--ledger", join(tmp(), "l.json")]);
  assert.equal(r.rc, 2);
  assert.match(r.err, /missing: --where/);
});

test("debt: only unlanded rows; overdue is relative to the retraction date", () => {
  const d = debt(EXAMPLE, TODAY);
  assert.deepEqual(d.map((x) => x.id), ["FC-002", "FC-003", "FC-004", "FC-006"]);
  assert.ok(d.every((x) => x.overdue));
  const early = debt(EXAMPLE, "2025-01-20").find((x) => x.id === "FC-002");
  assert.equal(early.overdue, false); // 6d old, 14d allowance
});

test("ratchet: growth fails", () => {
  const dir = tmp();
  const ledger = put(dir, "l.json", EXAMPLE);
  const base = put(dir, "b.json", { overdue: ["FC-002", "FC-003"] });
  const r = run(["check", "--ledger", ledger, "--baseline", base, "--today", TODAY]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /FC-004, FC-006/);
});

test("ratchet: a new row inside its allowance does not fail", () => {
  const dir = tmp();
  const ledger = put(dir, "l.json", EXAMPLE);
  const base = put(dir, "b.json", { overdue: ["FC-002", "FC-003", "FC-004", "FC-006"] });
  assert.equal(run([...ADD, "--ledger", ledger]).rc, 0); // retracted 2025-04-01
  assert.equal(run(["check", "--ledger", ledger, "--baseline", base, "--today", "2025-04-02"]).rc, 0);
  assert.equal(run(["check", "--ledger", ledger, "--baseline", base, "--today", "2025-04-20"]).rc, 1);
});

test("ratchet: shrink passes and says so; same state passes", () => {
  const dir = tmp();
  const ledger = put(dir, "l.json", EXAMPLE);
  const base = put(dir, "b.json", { overdue: ["FC-002", "FC-003", "FC-004", "FC-006"] });
  assert.equal(run(["check", "--ledger", ledger, "--baseline", base, "--today", TODAY]).rc, 0);
  assert.equal(run(["land", "FC-002", "--evidence", "commit abc", "--ledger", ledger, "--today", TODAY]).rc, 0);
  const r = run(["check", "--ledger", ledger, "--baseline", base, "--today", TODAY]);
  assert.equal(r.rc, 0);
  assert.match(r.out, /debt shrank \(FC-002\)/);
});

test("check fails closed on a corrupt ledger, missing baseline, malformed baseline", () => {
  const dir = tmp();
  const bad = clone(EXAMPLE);
  bad.claims[0].root_cause_category = "nope";
  const base = put(dir, "b.json", { overdue: [] });
  assert.equal(run(["check", "--ledger", put(dir, "bad.json", bad), "--baseline", base, "--today", TODAY]).rc, 2);
  const good = put(dir, "g.json", EXAMPLE);
  assert.equal(run(["check", "--ledger", good, "--baseline", join(dir, "none.json"), "--today", TODAY]).rc, 2);
  assert.equal(run(["check", "--ledger", good, "--baseline", put(dir, "m.json", { rows: [] }), "--today", TODAY]).rc, 2);
  assert.equal(run(["check", "--ledger", good, "--today", TODAY]).rc, 2);
});

test("land: needs evidence, refuses unknown and already-landed rows", () => {
  const dir = tmp();
  const ledger = put(dir, "l.json", EXAMPLE);
  assert.equal(run(["land", "FC-002", "--ledger", ledger]).rc, 2);
  assert.equal(run(["land", "FC-999", "--evidence", "x", "--ledger", ledger]).rc, 2);
  assert.equal(run(["land", "FC-001", "--evidence", "x", "--ledger", ledger]).rc, 1);
});

test("list and debt render", () => {
  const dir = tmp();
  const ledger = put(dir, "l.json", EXAMPLE);
  assert.match(run(["list", "--ledger", ledger]).out, /6 row\(s\)/);
  assert.match(run(["debt", "--ledger", ledger, "--today", TODAY]).out, /4 owed, 4 overdue/);
});

test("ratchet() rejects a malformed baseline", () => {
  assert.throws(() => ratchet(EXAMPLE, { overdue: "FC-001" }, TODAY), /baseline must look like/);
});

test("shipped example baseline matches the shipped example ledger", () => {
  const base = JSON.parse(readFileSync(new URL("../ledger/example-baseline.json", import.meta.url), "utf8"));
  const r = ratchet(EXAMPLE, base, TODAY);
  assert.deepEqual(r.grew, []);
  assert.deepEqual(r.shrunk, []);
});

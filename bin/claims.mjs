#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load, save, nextId, debt, ratchet, overdueIds } from "../lib/ledger.mjs";

const USAGE = `usage: claims <command> [options]
  add       --claim --where --instrument --result --true-value --caught-by
            --category --root-cause --retraction --fix --allowance-days [--stated-at]
  list
  debt      rows whose durable fix has not landed
  land <id> --evidence <pointer> [--at]   (the only edit a row ever gets)
  check     --baseline <file>             exit 1 if overdue debt grew
  baseline  print the current baseline
global: --ledger <file> (default claims.json)  --today YYYY-MM-DD (default: now)  --json
`;

const OPTS = {
  ledger: { type: "string", default: "claims.json" },
  today: { type: "string" },
  baseline: { type: "string" },
  json: { type: "boolean", default: false },
  "stated-at": { type: "string" },
  claim: { type: "string" },
  where: { type: "string" },
  instrument: { type: "string" },
  result: { type: "string" },
  "true-value": { type: "string" },
  "caught-by": { type: "string" },
  category: { type: "string" },
  "root-cause": { type: "string" },
  retraction: { type: "string" },
  fix: { type: "string" },
  "allowance-days": { type: "string" },
  evidence: { type: "string" },
  at: { type: "string" },
};

export function main(argv, out = console.log, err = console.error) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTS, allowPositionals: true });
  } catch (e) {
    err(e.message);
    err(USAGE);
    return 2;
  }
  const { values: v, positionals: [cmd, arg] } = parsed;
  const today = v.today ?? new Date().toISOString().slice(0, 10);
  try {
    switch (cmd) {
      case "add": return add(v, today, out, err);
      case "list": return list(v, out);
      case "debt": return showDebt(v, today, out);
      case "land": return land(arg, v, today, out, err);
      case "check": return check(v, today, out, err);
      case "baseline":
        out(JSON.stringify({ overdue: overdueIds(load(v.ledger), today) }, null, 2));
        return 0;
      default:
        err(USAGE);
        return 2;
    }
  } catch (e) {
    err(e.message);
    return 2;
  }
}

function add(v, today, out, err) {
  const need = ["claim", "where", "instrument", "result", "true-value", "caught-by", "category", "root-cause", "retraction", "fix", "allowance-days"];
  const missing = need.filter((k) => v[k] == null);
  if (missing.length) {
    err(`missing: ${missing.map((m) => `--${m}`).join(" ")}`);
    return 2;
  }
  const allowance = Number(v["allowance-days"]);
  if (!Number.isInteger(allowance)) {
    err("--allowance-days must be an integer");
    return 2;
  }
  const ledger = existsSync(v.ledger) ? load(v.ledger) : { version: 1, claims: [] };
  const row = {
    id: nextId(ledger),
    stated_at: v["stated-at"] ?? today,
    stated_where: v.where,
    claim: v.claim,
    measurement: { instrument: v.instrument, result: v.result },
    true_value: v["true-value"],
    caught_by: v["caught-by"],
    root_cause_category: v.category,
    root_cause: v["root-cause"],
    retraction: { at: today, text: v.retraction },
    durable_fix: { description: v.fix, allowance_days: allowance, landed: false },
  };
  ledger.claims.push(row);
  try {
    save(v.ledger, ledger); // validates first; nothing is written on failure
  } catch (e) {
    err(e.message);
    return 1;
  }
  out(`recorded ${row.id} (${row.root_cause_category}); durable fix owed within ${allowance}d`);
  return 0;
}

function list(v, out) {
  const { claims } = load(v.ledger);
  if (v.json) {
    out(JSON.stringify(claims, null, 2));
    return 0;
  }
  for (const c of claims) {
    out(`${c.id}  ${c.root_cause_category.padEnd(28)} ${c.caught_by.padEnd(15)} fix:${c.durable_fix.landed ? "landed" : "OWED  "}  ${c.claim}`);
  }
  out(`${claims.length} row(s)`);
  return 0;
}

function showDebt(v, today, out) {
  const rows = debt(load(v.ledger), today);
  if (v.json) {
    out(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const d of rows) {
    out(`${d.id}  ${d.overdue ? "OVERDUE" : "open   "}  ${d.age_days}d of ${d.allowance_days}d  ${d.fix}`);
  }
  out(`${rows.length} owed, ${rows.filter((d) => d.overdue).length} overdue (as of ${today})`);
  return 0;
}

function land(id, v, today, out, err) {
  if (!id || !v.evidence) {
    err("usage: land <id> --evidence <pointer> [--at YYYY-MM-DD]");
    return 2;
  }
  const ledger = load(v.ledger);
  const row = ledger.claims.find((c) => c.id === id);
  if (!row) {
    err(`no such row: ${id}`);
    return 2;
  }
  if (row.durable_fix.landed) {
    err(`${id} already landed`);
    return 1;
  }
  Object.assign(row.durable_fix, { landed: true, landed_at: v.at ?? today, evidence: v.evidence });
  try {
    save(v.ledger, ledger);
  } catch (e) {
    err(e.message);
    return 1;
  }
  out(`${id}: durable fix landed`);
  return 0;
}

function check(v, today, out, err) {
  if (!v.baseline) {
    err("check needs --baseline <file>");
    return 2;
  }
  if (!existsSync(v.baseline)) {
    err(`no baseline at ${v.baseline}`);
    return 2;
  }
  const ledger = load(v.ledger); // an invalid ledger throws -> exit 2, never "pass"
  const baseline = JSON.parse(readFileSync(v.baseline, "utf8"));
  const r = ratchet(ledger, baseline, today);
  if (r.grew.length) {
    err(`FAIL: overdue debt grew: ${r.grew.join(", ")}. Land the durable fix; do not raise the baseline.`);
    return 1;
  }
  if (r.shrunk.length) out(`debt shrank (${r.shrunk.join(", ")}); prune the baseline with: claims baseline > ${v.baseline}`);
  out(`ok: ${r.now.length} overdue, baseline allows ${baseline.overdue.length} (as of ${today})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

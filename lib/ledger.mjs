import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "ledger", "schema.json"), "utf8"));

const DAY = 86_400_000;

function realDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Schema errors plus the cross-field rules a schema cannot express.
export function validateLedger(ledger) {
  const errs = validate(ledger, SCHEMA);
  if (errs.length) return errs;
  const seen = new Set();
  ledger.claims.forEach((c, i) => {
    const p = `$.claims[${i}]`;
    if (seen.has(c.id)) errs.push(`${p}: duplicate id ${c.id}`);
    seen.add(c.id);
    for (const [where, d] of [["stated_at", c.stated_at], ["retraction.at", c.retraction.at], ["durable_fix.landed_at", c.durable_fix.landed_at]]) {
      if (d != null && !realDate(d)) errs.push(`${p}.${where}: not a real calendar date`);
    }
    if (c.retraction.at < c.stated_at) errs.push(`${p}: retraction predates the claim`);
    const f = c.durable_fix;
    if (f.landed && !f.landed_at) errs.push(`${p}.durable_fix: landed=true needs landed_at`);
    if (f.landed && !f.evidence) errs.push(`${p}.durable_fix: landed=true needs evidence (a pointer to the fix)`);
    if (!f.landed && (f.landed_at || f.evidence)) errs.push(`${p}.durable_fix: landed_at/evidence set but landed=false`);
  });
  return errs;
}

export function load(path) {
  if (!existsSync(path)) throw new Error(`no ledger at ${path}`);
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  const errs = validateLedger(ledger);
  if (errs.length) throw new Error(`invalid ledger ${path}:\n  ${errs.join("\n  ")}`);
  return ledger;
}

export function save(path, ledger) {
  const errs = validateLedger(ledger);
  if (errs.length) throw new Error(`refusing to write invalid ledger:\n  ${errs.join("\n  ")}`);
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function nextId(ledger) {
  const max = ledger.claims.reduce((m, c) => Math.max(m, Number(c.id.slice(3))), 0);
  return `FC-${String(max + 1).padStart(3, "0")}`;
}

// Rows whose durable fix has not landed. `overdue` = owed past the allowance,
// counted from the retraction date. Only overdue rows are ratcheted: a fresh
// row gets its allowance before it can fail CI.
export function debt(ledger, today) {
  return ledger.claims
    .filter((c) => !c.durable_fix.landed)
    .map((c) => {
      const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.retraction.at}T00:00:00Z`)) / DAY);
      return { id: c.id, age_days: age, allowance_days: c.durable_fix.allowance_days, overdue: age > c.durable_fix.allowance_days, fix: c.durable_fix.description };
    });
}

export const overdueIds = (ledger, today) => debt(ledger, today).filter((d) => d.overdue).map((d) => d.id).sort();

// Ratchet: overdue debt may shrink, never grow. `grew` = overdue ids not in the
// baseline. `shrunk` = baseline ids no longer overdue (prune them).
export function ratchet(ledger, baseline, today) {
  if (!baseline || !Array.isArray(baseline.overdue) || !baseline.overdue.every((x) => typeof x === "string")) {
    throw new Error('baseline must look like {"overdue": ["FC-001", ...]}');
  }
  const now = overdueIds(ledger, today);
  return {
    grew: now.filter((id) => !baseline.overdue.includes(id)),
    shrunk: baseline.overdue.filter((id) => !now.includes(id)),
    now,
  };
}

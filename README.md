# False-claim ledger

A small, runnable record-and-enforce loop for one failure of AI agents: stating
a confident claim that a later measurement shows to be false.

This is extracted in spirit from a private harness that runs a persistent fleet
of Claude Code agents. Everything here is a fresh reimplementation with
synthetic example data. Node 20+, no dependencies.

## The problem

Agents report things like "no lint growth", "tests pass", "landed on main".
People act on those sentences. When one turns out false, correcting the
sentence helps nothing: it has already been read and used.

In the harness this came from, one month produced 38 such claims. Sixteen were
caught only by the human owner, not by any check. Eleven came from the same
root cause, measuring a proxy (a pipeline's last exit status, a comparison that
silently lost its config) instead of the thing claimed. Durable fixes landed
for 27 of the 38. The rest were still owed, which is the gap this ledger tracks.

## The mechanism

1. An agent states a claim.
2. A later measurement contradicts it.
3. The agent retracts, and adds a ledger row: the claim, the measurement, the
   true value, who caught it, a root-cause category, the retraction, and the
   **durable fix** owed. The fix targets the instrument or the reflex that
   trusted it, so the class of error becomes unavailable. Fixing the sentence
   does not count.
4. A checker fails CI while any row's durable fix is owed past its allowance.
   Overdue debt is ratcheted against a baseline: it may shrink, never grow.

Rows get an allowance (days from the retraction) so a fresh row does not fail
CI the minute it is written. Once past it, the row is debt.

## Layout

```
ledger/schema.json            JSON Schema for the ledger
ledger/example-ledger.json    6 synthetic rows
ledger/example-baseline.json  overdue debt allowed for the example ledger
bin/claims.mjs                CLI: add, list, debt, land, check, baseline
lib/                          validator (subset of JSON Schema), ledger logic
test/                         node --test tests
hooks/                        optional second piece, see below
.github/workflows/check.yml   CI: tests + ratchet (never triggered locally)
```

## Run it

```
$ node --test
...
# tests 24
# pass 24
# fail 0
```

List rows and debt (`--today` pins the date so output is reproducible):

```
$ node bin/claims.mjs list --ledger ledger/example-ledger.json
FC-001  proxy-substitution           peer-agent      fix:landed  No lint growth versus the base branch.
FC-002  proxy-substitution           automated-check fix:OWED    All tests pass.
FC-003  design-intent-as-effect      owner           fix:OWED    The change has landed on the main branch.
FC-004  stale-value-as-live          owner           fix:OWED    The service is currently healthy.
FC-005  display-limit-as-result-set  peer-agent      fix:landed  Only two call sites use the deprecated function.
FC-006  unvalidated-instrument       owner           fix:OWED    About a third of internal links are broken.
6 row(s)

$ node bin/claims.mjs debt --ledger ledger/example-ledger.json --today 2025-03-31
FC-002  OVERDUE  76d of 14d  Shell wrapper for test runs sets pipefail and reports the runner's own status; bare pipelines into tee are rejected by a lint rule.
FC-003  OVERDUE  55d of 14d  Hand-off template has no free-text 'landed' field; it embeds the output of a reachability check against main.
FC-004  OVERDUE  49d of 30d  Status lines are generated from a probe that prints the read time; hand-typed status values are rejected in summaries.
FC-006  OVERDUE  26d of 14d  Measurement helper refuses to print a count until its pattern matches a positive control; exits 'unproven' otherwise.
4 owed, 4 overdue (as of 2025-03-31)

$ node bin/claims.mjs check --ledger ledger/example-ledger.json --baseline ledger/example-baseline.json --today 2025-03-31
ok: 4 overdue, baseline allows 4 (as of 2025-03-31)
```

Record a new claim, then watch the ratchet once its allowance has passed
(run on a copy of the example ledger):

```
$ node bin/claims.mjs add --ledger l.json --today 2025-04-01 \
    --claim "Build is green." --where "chat" --instrument "CI re-run" --result "red" \
    --true-value "build red" --caught-by owner --category proxy-substitution \
    --root-cause "Read a cached status badge." --retraction "Build was red." \
    --fix "Badge replaced by live status query." --allowance-days 7
recorded FC-007 (proxy-substitution); durable fix owed within 7d

$ node bin/claims.mjs check --ledger l.json --baseline ledger/example-baseline.json --today 2025-04-20
FAIL: overdue debt grew: FC-007. Land the durable fix; do not raise the baseline.
(exit 1)
```

An unknown category is refused and nothing is written:

```
$ node bin/claims.mjs add --ledger l.json ... --category bad-luck ...
refusing to write invalid ledger:
  $.claims[7].root_cause_category: "bad-luck" not in [proxy-substitution, unvalidated-instrument, wrong-access-path, stale-value-as-live, display-limit-as-result-set, design-intent-as-effect, inference-beyond-observation]
(exit 1)
```

Paying the debt: `claims land FC-002 --evidence "<pointer to the fix>"`. The check
then reports the shrink and asks you to prune the baseline
(`claims baseline > baseline.json`).

Exit codes: 0 ok, 1 refused or ratchet failed, 2 usage or invalid input.

## Design choices

- **Fail closed on unknown categories.** The root-cause category is a closed
  enum with no "other". A new failure class needs a deliberate schema change.
  A malformed ledger, a missing baseline or a malformed baseline makes `check`
  exit 2, never pass. The validator throws on schema keywords it does not
  implement, so a schema edit cannot be silently ignored.
- **A ratchet, not a threshold.** "At most N overdue" lets debt creep up to N
  and sits there. A baseline of ids means any new overdue row fails, and paying
  one down is visible.
- **A retraction is a record, not an edit.** `add` appends. There is no delete
  or edit command. The one permitted change to a row is `land`, which records
  that the fix landed and requires evidence. A landed fix with no evidence is
  invalid.
- **Fixing the instrument.** Every row must name a durable fix, and the
  example fixes make the measurement refuse to run unsafely (empty comparisons,
  truncated output, unproven patterns).

## Limits

- It records and enforces follow-up. **It does not detect false claims.**
  Someone or something must still re-measure and notice.
- Whether a "durable fix" is durable is a judgment. The tool checks that one
  is named and marked landed with evidence, not that it works.
- The root-cause categories are a taxonomy I chose; they are coarse.
- Reviewers, human or model, share blind spots. In the source harness the
  reviewing agents share a model family with the claiming agents, so some
  errors will be missed in both directions. That is why the owner-caught count
  above matters.
- The example CI pins `--today` because the example data has fixed dates. A
  real ledger would omit it.

## Second piece: a hook

`hooks/` holds a Claude Code `PreToolUse` hook that denies a shell wait loop
whose `pgrep -f` pattern matches the loop's own command line (it can never
exit). It is a small case of the same idea: make the bad measurement
unavailable instead of asking for care. See [hooks/README.md](hooks/README.md).

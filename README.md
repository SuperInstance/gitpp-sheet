# gitpp-sheet

> A git.pp fold as a spreadsheet with cell-level confidence, and the
> graph that shows where the confidence came from.

## The gap this fills

A fold already IS a spreadsheet:

| | |
|---|---|
| `state` | key → value — the cells |
| `setters` | key → record — cell provenance |
| `order` | the dependency order |
| `conflicts` | who lost — the audit trail |

What it does NOT have is a way to say **how sure we are of a cell**.

Jev (TypeSafe AI) supplies calibrated probabilities for claims about
text. A fold is a *propagation* structure. So:

```
spec text ──Jev──> per-claim confidence ──fold──> per-CELL confidence
```

A cell's confidence is not the confidence of the record that set it. It
is the confidence of the *decision* that made it the winner — and that
decision depends on the losing candidates too.

## The two ideas that make it work

**1. Score the CLAIM, not the record.** "This record is a task" is a
property of a record. The fold does not depend on record properties; it
depends on relations between them. The claim that actually decides a
cell is *"r2 (a task) outranks r7 (a witness) for key k0"* — and that is
also the only kind of claim a text-grounded judge can answer.

**2. Propagate through the fold, not through the picture.** A cell
whose value is unaffected by any uncertain decision is *certain*, even
if every record involved was scored 0.7. An average of record scores is
not a confidence.

Confidence is the **minimum** over the decisions that produced the
cell, not the mean and not a product:

- a **mean** lets one uncertain decision hide behind many certain ones,
  which is how a confidence display becomes a lie
- a **product** compounds independent decisions and understates
  certainty for a decision that is certain

The minimum is the honest summary of "what is the weakest link in the
argument for this cell".

## What the instrument found

The first run flagged two cells as fragile at 14% and 11%:

```
env.load   witness  14%   <-- FRAGILE
same       task     11%   <-- FRAGILE
```

Both were **same-class contests** — "a witness outranks a witness",
"a task outranks a task". The spec says `override > task > witness` and
says nothing about same-class records; those are decided by §5.4's
tie-break. So the claim was asking about the wrong clause, the judge
correctly answered "the spec does not settle this", and the fragility
was an artefact of **my claim extraction**, not of the spec.

The claim set was fixed to ask the tie-break question for same-class
contests, and both cells went to 96% and 97%.

**A judge that reads the spec found a hole in the code that asks the
judge.** That is the whole point of the arrangement: the instrument is
only useful when its output is allowed to say the harness is wrong.

## Files

| | |
|---|---|
| `src/sheet.mjs` | cells, provenance, confidence, propagation, dependency queries |
| `src/claims.mjs` | turns a fold into the claims that decide it |
| `src/jev.mjs` | a thin Jev client, grouping claims by clause |
| `src/graph.mjs` | SVG graph + a text rendering of the same information |
| `demo.mjs` | end-to-end: fold → claims → Jev → sheet → graph |
| `test/sheet.test.mjs` | 8 cases, mutation-verified |

## The test suite is mutation-verified

| mutation | result |
|---|---|
| mean instead of minimum | 7 pass, **1 fail** |
| read `setters` only, ignore the conflict ledger | 7 pass, **1 fail** |
| propagate a loser's uncertainty | 7 pass, **1 fail** |
| clean | **8 pass, 0 fail** |

## Two deliberate design choices

**A loser's uncertainty does not propagate.** If the winner is
uncertain the cell is uncertain; if a *loser* is uncertain, the cell is
not, because the loser's opinion did not determine the value.

**The winner is read from the conflict ledger first.** A port that does
not emit `setters` is legal. Reading only `setters` would produce a
sheet with null setters, no decisions, and therefore **100% confidence
on every cell** — certain because it knows nothing, which is worse than
no sheet at all.

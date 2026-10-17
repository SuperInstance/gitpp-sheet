# What Jev can and cannot do — measured, not assumed

Everything here was executed against `api.typesafe.ai/v1/systemone`
(model `jev-1.13.0`, ~0.06–0.12 s/request). The capability probe used
26 labelled claims plus 10 world facts; the frame comparison used the
same set against this project's own `SPEC.md`.

## 1. The state IS load-bearing — but only if you frame it right

A bare claim leaks world knowledge. Against a spec that never mentions
Python:

| claim | bare frame | explicit-state frame |
|---|---|---|
| "Python is a programming language." | **0.95** | **0.26** |
| "The capital of France is Paris." | 0.09 | 0.02 |
| "Water boils at 100 °C at sea level." | 0.07 | 0.02 |

The fix is the frame, and it is **one clause**:

> **"Answer true only if the state document explicitly states the
> following: &lt;claim&gt;"**

Over 9 true + 7 false + 10 world claims against this project's spec:

| frame | TRUE mean | FALSE mean | WORLD mean | world FP @0.5 | separation |
|---|---|---|---|---|---|
| bare "supports this statement" | 0.977 | 0.043 | 0.153 | **1/10** | 0.824 |
| **"explicitly states"** | 0.950 | 0.031 | **0.035** | **0/10** | **0.915** |

Both separate true from false. Only the explicit frame separates them
from **world knowledge** — and a judge answering from world knowledge is
answering "what is true" and labelling it "what the spec says", which
is the one distinction the whole reading-room method rests on.

> A caution learned the hard way: two of my seven "false" claims were
> actually **true** per the spec (the leaf *is* the SHA-256 of canonical
> JSON; the closure root *is* over the transitive closure). Jev was
> right and my ground truth was wrong. Getting the labels right is part
> of the measurement.

## 2. Batching is free — except near the gate

8 questions in one request and 40 in one request both reproduce solo
scores to within **0.003**, and run-to-run noise is 0.002–0.005 with
zero drift. But on deliberately borderline items the joint-vs-solo
delta reached **0.037** — larger than the noise floor.

**Rule:** batch freely for screening; re-ask in isolation anything
scoring 0.3–0.7 before letting it gate.

## 3. Framing barely matters, with two exceptions

Attribution ("The spec says X"), bare ("X") and endorsement ("It is
correct that X") frames are **bit-identical** — 0.980, 0.980, 0.980.
The frames that do move the score:

| frame | Δ |
|---|---|
| negation ("It is false that X") | **0.96** — semantically correct, and a trap for any rule expecting a supported claim |
| epistemic humility ("it is possible that X, though I am not certain") | −0.16 |
| "it is widely known that X" | −0.14 |

**Rule:** never let a claim's polarity live in the instruction, and
strip hedging adverbs.

## 4. The worst failure mode: the judge sees a contradiction and ignores it

Asked whether a state contains conflicting clauses, Jev answers
**0.92–0.96**. Asked, *in the same state*, whether a false clause is
true, it answers **0.79** — and that false clause crossed 0.5 in **10 of
10 runs**. Both sides get partial credit, biased about **+0.14 toward
the later clause**.

Reproduced on this project's own spec:

| | clean spec | contradictory spec |
|---|---|---|
| contradiction detected | 0.38 | **0.96** |
| a FALSE claim scores | **0.01** | **0.86** |
| a TRUE claim scores | 0.98 | 0.76 |

The same claim moves from 0.01 to 0.86 because a later clause
contradicts an earlier one, and a claim that was true at 0.98 falls to
0.76.

**Rule: contradiction detection MUST be a separate upstream pass.** The
judge will not act on a contradiction it can see. `src/guards.mjs`
enforces it, and a contradictory state yields **no scores at all**
rather than a confident wrong one.

## 5. Aggregate claims land ambiguously, and that is worse than being wrong

"Five of the twelve records set key k0" scored **0.511 ± 0.044** —
decided by a coin flip — while a comparable counting claim scored
0.983. The failure is not miscounting; it is *ambiguity*, and an
ambiguous score that occasionally clears a gate is worse than no score.

**Rule: never gate on a count.**

## 6. Instance-level granularity works, and structure beats prose

Claims about a **specific record** ("record r0007 sets key k0 to 2")
scored 0.990 / 0.010 — identical separation to rule-level claims. No
granularity penalty.

Where a structured record and a prose sentence **contradict** each
other, the structured one wins decisively: the prose claim scored
**0.030** and the structured one **0.940**.

**Rule: put facts in structured fields, not prose.**

## What this means for the harness

- **Ask about the DOCUMENT, not the world.** The "explicitly states"
  frame is worth 0.09 of separation against leakage and costs nothing.
- **Check for contradiction first, always.**
- **Do not gate on counts.**
- **Re-ask anything near the line, alone.**
- **Keep the claims polarity-positive and unhedged.**

The last one is a design constraint on *this* project: a claim is a
positive statement about the spec ("a record of kind X outranks a
record of kind Y"), never a question, never a negation, never hedged.
The claim set is the interface, and its shape is what makes the judge's
output usable.

---

# Experiment 2 — is the state load-bearing?

**Yes, decisively.** 550 API calls, two independently written documents,
20 true claims scored under each state.

| state | mean score of a true claim | sd |
|---|---|---|
| correct document | **0.9895** | 0.0022 |
| unrelated document | **0.0170** | 0.0073 |
| **empty `{}`** | **0.1550** | 0.0385 |

- correct − unrelated: **Δ = +0.9725**, 95% CI [+0.9690, +0.9755], t(19)=607, p≈3e-42
- AUC separating true from false claims: **1.000**
- Run-to-run spread on saturated cells: **0.000** — effectively
  deterministic, no averaging needed

**So the spec-reader use is sound. No finding in the reading-room
project is void on the grounds that the state was decorative.**

## 7. An EMPTY state does not produce a low score — it produces a confident wrong one

This is the most dangerous measured property, and it is the one the
project's own failure modes would have hit.

| state | score of a WORLD fact absent from it |
|---|---|
| correct document | **0.038** |
| unrelated document | 0.049 |
| **empty `{}`** | **0.610** |

Paired empty − unrelated: **Δ = +0.561**, t(9)=25.6, p<0.0001.

Jev consults world knowledge **only when the state is empty**. A harness
that failed to fetch the spec would therefore report *confident
nonsense at ~0.6* — indistinguishable from a confident spec reading —
rather than an error. The signature of an empty state is a mid-range
score on a claim that should be cleanly supported or cleanly not.

**Guard:** `stateIsUsable()` refuses `{}`, `""`, `{a: null}`, and
missing state, before any claim is scored. A state-load failure now
produces an error rather than a plausible number.

## 8. Numbers: no false positives, but implied numbers are ambiguous

Measured against this project's own SPEC.md (5,743 words, 360 numeric
tokens):

| claim | score |
|---|---|
| "at least 1e16 is encoded in **integer digits**" (flatly false) | **0.02** |
| "less than 1e-4 is encoded in integer digits" (false) | 0.03 |
| "the encoding of a number is never scientific" (false) | 0.02 |
| "at least 1e16 is encoded in scientific notation" (stated) | 0.83 |
| "at least 1e15 is encoded in scientific notation" (false) | 0.03 |

**Wrong numbers do not produce false positives.** The risk is narrower:
a number the document only **implies** lands in the ambiguous band
(`1e17` → 0.50, `1e18` → 0.69), because the reader must infer it. A
separate capability probe found the same thing from the other side: in
long documents, false numeric claims drift toward 0.2–0.5 **ordered by
numeric proximity to the text's number** (300 kg → 0.49, 500 → 0.52,
1000 → 0.38, 1500 → 0.22).

**Guard:** a claim containing a quantity is never gated on directly.
It is either rephrased to use the number the document states, or routed
to a human.

## 9. Operating limits, measured

| | |
|---|---|
| context ceiling | works at 30,014 words, **fails at 35,014** (`max_tokens_exceeded`). **Our spec is 5,743 words — 5× under the limit.** |
| burial depth | irrelevant. Facts at 0% / 25% / 50% / 75% / 100% depth of a long document all score 0.98–0.99 |
| state shape | irrelevant. dict, single key, nested multikey, bare string all score 0.99 |
| invalid state | `null` / omitted → clean HTTP 422; `0` / `true` → 422 (`string_type`) |
| garbage state | degrades safely. Word salad, wrong-typed dicts → 0.01–0.02 on both true and false claims |
| unreliability | 8 non-scoring responses in 550 calls, **all intentional probes**. Zero unexplained failures |

## 10. Two measurement traps, recorded because they nearly produced false findings

**Near-duplicate documents manufacture false positives.** A "false"
claim scored 0.82 because the *unrelated* control document happened to
contain the same person name. That is evidence the judge reads the
state — but it means **unrelated distractors must be name-disjoint**,
or a control will manufacture positives.

**A long document can hide a falsified control.** One control column
was invalid for n≥9 because the control claim was not actually present
in the generated filler. The run was discarded rather than reported.

Both of those are the same lesson the whole project keeps learning: a
control that was not verified to be a control is not a control.

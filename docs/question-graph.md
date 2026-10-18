# The chain of thought as a graph of questions

> A big model is good at deciding **what to do**. It is bad at deciding
> whether its own premises are supported, and it is expensive to ask
> again.
>
> So: the big model **authors** the reasoning, the judge **certifies**
> the premises, and everything downstream is **arithmetic on a durable
> record**.

## The problem this solves

A chain of thought is ephemeral. It lives in one model's context, it is
executed once, and it is gone. The scores that justified it are gone
too. So the next question starts from nothing, even when the next
question is 95% the same question.

`gitpp-sheet` already had the pieces:

| existing | what it is |
|---|---|
| `claims.mjs` | the questions a fold implies |
| `guards.mjs` | how a judge may be trusted, each rule citing a measurement |
| `sheet.mjs` | cells with confidence, the confidence of a **decision** |
| `triggers.mjs` | go/no-go on one action |

What it did not have was **structure**, and structure is what makes the
rest durable.

## Three things that are currently conflated

A question graph separates them, and the separation is the whole design:

| | what it is | who can speak to it |
|---|---|---|
| **CERTIFIED** | a question asked of a document, with a verdict | the judge |
| **ASSERTED** | an edge: "this part depends on that part" | **nobody** — it is authored |
| **OBSERVED** | the score, plus the document it was read against, and whether it was asked alone or in a batch | the judge, with provenance |

The edge is the interesting one. **The judge reads text; it does not do
logic.** It can tell you the document states X. It cannot tell you that
X therefore Y — and if the reasoning graph is built so that a
certificate covers the whole chain, then a single confident-but-wrong
premise launders the entire chain into apparent certainty.

So the receipt of a derived answer says how much of it is certified and
how much is merely asserted:

```
confidence 0.94 against a threshold of 0.50, resting on 2 CERTIFIED
question(s) and 2 ASSERTED edge(s) nobody checked. All of it was read
against 1 document(s) -- so these are 2 readings of ONE document, not
2 independent witnesses.
```

## The shape

```
PARTS -- the chain of thought, a DAG
  premise   "The spec states a class precedence."
  contest   "req-2 outranks obs-1 for config.timeout."   depends on premise
  apply     "So req-2 is the setter of config.timeout."  depends on contest

QUESTIONS -- the cluster of checkable things around each part
  q:precedence  part=premise  weight=1.0  binds_to=[config.timeout]
  q:contest     part=contest   weight=1.0  binds_to=[config.timeout]
  q:ancestry    part=contest   weight=0.3  binds_to=[config.timeout]
  q:apply       part=apply     weight=1.0  binds_to=[config.timeout]

DECISIONS -- what the script actually executes
  d:premise  requires=[q:precedence]              decides=(config.timeout, req-2, obs-1)
  d:contest  requires=[q:precedence, q:contest]   decides=(config.timeout, req-2, obs-1)
  d:apply    requires=[q:contest, q:apply]
```

Two distinct bindings, and conflating them attaches provenance to the
wrong cells:

- **`binds_to`** (on a question) — which cells the question is **about**.
- **`decides`** (on a decision) — which **(key, winner, loser)** contest
  the decision **settles**. A decision that settles no contest does not
  change any cell's confidence.

## Weights: four jobs, and one thing they must never do

A weight is **not** a confidence, and it must never enter the
confidence number. The whole project already learned that:

> a mean hides a single uncertain decision behind many certain ones,
> which is how a confidence display becomes a lie

A **weighted** mean is the same lie with extra steps. The confidence of
a decision is the **minimum** over the questions it requires. Full stop.
There is a test for exactly this, and it is worth keeping.

A weight has four real jobs:

1. **Whether the question is evidence at all.** `weight > 0` means it
   counts; `weight == 0` means "asked, but does not count".
2. **Isolation order.** When several questions are near the gate, the
   highest-weight one is re-asked first — re-asking is expensive, so
   re-ask the question whose answer is most likely to change the
   verdict.
3. **Blast radius.** If question `q` is wrong, which decisions and parts
   inherit the error, weighted and hop-counted so a direct dependent
   outranks a distant one.
4. **Reporting.** The *weight mass* of a part — how much evidence hangs
   on it. Which is not the same as how good the evidence is, and the
   receipt never conflates them.

## The correlation signal

This is the number a mean confidence cannot give you.

> Five questions scored against one document are **five readings of one
> document**. They are not five independent witnesses. If the document
> is wrong, they are wrong together.

So every observation records the **hash of the state it was read
against**, and every decision reports how many **distinct documents**
its evidence came from.

That count is reported *with its caveat*, not as a confidence: three
documents are better than one only if the three are independent, and
the graph **asserts** that — it does not verify it.

## The corpus may be a paid expert

The corpus a question is read against is no longer only a document. A
question's state may name a **professional** behind an API — a model id,
an endpoint, and the request to put to them — and the observation then
carries the request, the **answer**, the price and the latency.

The same signal generalises, and it is worth being exact about why:

> **Five questions answered by one expert are five readings of one
> expert**, exactly as five questions over one document are five
> readings of one document. An expert is not five witnesses in a
> trenchcoat — it is one respondent whose priors every answer shares.
> Asking one expert five times buys a tighter estimate of *one opinion*,
> not five opinions.

So the count is reported in **two columns, never averaged together** —
`documents` and `experts` — because a document and an expert are
different kinds of dependence and combining them would hide which kind is
carrying the evidence. Both stay **counts**, with the caveat attached,
and neither is ever turned into a confidence.

The expert's **answer** is kept verbatim, where a judge's score was all
there was. That is the difference between the two corpora: the number is
all a judge has, and the text is all the money bought.

Full shape, the two hashes, the sufficiency gate and its measured band:
**[`docs/EXPERT-CORPUS.md`](EXPERT-CORPUS.md)**.

## The closure property

The ledger is the durable artifact, and it makes one testable claim:

> **A ledger is sufficient.** Everything a decision's verdict depends on
> is in the ledger, so the verdict can be reproduced from the ledger
> with **no judge call at all**.

If that holds, then:

- a **derived question** — one nobody asked — can be answered from the
  ledger, with no new judge call;
- a **script** can be replayed with no judge call;
- a **small model**, or no model at all, can read the ledger and answer
  questions the big model asked.

The big model's job shrinks to authoring the graph. The judge's job
shrinks to producing the observations. Everything downstream is
arithmetic.

The corollary is the useful one: **the expensive part (observing) and
the cheap part (recombining) come apart.**

## The refusal paths

Two ways the method says NO, and both are refusals rather than guesses:

**A question nobody observed.**

```
NOT ANSWERED: no observation for q:ancestry. A derived answer may only
use what was observed; a missing observation is not a weak observation,
it is an absent one.
```

**A near-threshold answer that was asked in a batch.** A batched
borderline score moves by up to 0.037, while a solo one reproduces to
within 0.005 — so a batched borderline score cannot settle anything and
must be re-asked alone.

**An empty state.** A question with no state is refused at *definition*
time, and a script refuses to *ask* one at run time. Measured: an empty
state makes the judge answer from its own beliefs at ~0.610, which is
indistinguishable from a confident reading of a document.

## "Or even just a JEV percentage"

This is worth answering precisely, because the answer is **no**, and
the reason is the most useful thing in this design.

A bare score is not safe to read. Measured on this project's own spec, a
**false** claim scores **0.01** against a clean document and **0.86**
against a document with one contradicting clause appended. Same number
space, invisible in the number.

A score is only meaningful **together with** the state it was read
against, the guards that were applied, and whether it was asked alone.

So the ledger stores the **adjudicated** observation, not the raw
score:

| column | what a consumer gets |
|---|---|
| `score` | the number, for a consumer that knows the caveats |
| `verdict` | what the guards made of it — **this is the safe column** |
| `mode` | `solo` or `batched` — and therefore whether the 0.037 band applies |
| `stateHash` | which document it was read against |
| `at` | when |

**The right parsing is: read the verdict.** A consumer that reads
`verdict` is safe. A consumer that reads `score` alone is reading a
number whose meaning was decided by a contradiction guard it never saw.

That is what "raw data read with the right parsing" has to mean for
this to work with a smaller model.

## The script

A script is an ordered list of steps, each naming a decision. It is the
go/no-go, but a **sequence** rather than a number: the answer to
"should we do this?" is a trace through the steps that were certified.

Two properties:

- **It is replayable.** Given a ledger, the script runs with no judge
  call at all.
- **It stops at the first failure.** A script is an *order* of
  reasoning. If step 2 fails, step 3 never happened, and the trace must
  say so rather than reporting the worst outcome of steps that ran
  anyway.

## What this does NOT do

- It does not verify the **edges**. The judge certifies premises. The
  inference from one premise to the next is authored, and the receipt
  says so.
- It does not make the observations **independent**. Two questions over
  one document are two readings of one document, and the receipt says
  so. Nor does a paid expert help: two questions answered by one expert
  are two readings of one expert, and the receipt says that too, in its
  own column.
- It does not sharpen the scores. Borderline scores move by 0.037
  regardless of how they were obtained. The design propagates that
  band honestly instead of hiding it.
- It does not replace the big model. It replaces the big model's
  *second* opinion with a certified one, and frees it to author rather
  than to re-derive.

## Files

| file | what it is |
|---|---|
| `src/qgraph.mjs` | parts, questions, weights, decisions; validation; the corpus (document or expert) |
| `src/ledger.mjs` | the durable artifact: observations, provenance, rows |
| `src/derive.mjs` | derived questions, answered from the ledger alone; sufficiency |
| `src/script.mjs` | the go/no-go scripter |
| `test/qgraph.test.mjs` | the closure property, and every way the method must not lie |
| `test/expert.test.mjs` | the same, over a corpus that costs money |
| `demo-graph.mjs` | the whole loop, with a deterministic mock judge |
| `demo-expert.mjs` | the whole loop against two experts and one document |
| `docs/EXPERT-CORPUS.md` | the expert corpus, the correlation signal, sufficiency |

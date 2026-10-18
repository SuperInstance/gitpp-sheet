# The corpus may be a paid expert's answer

> Put an API to a cloud service in a cell and it can do the job for a
> price. As long as the IO is logged, and other calls use the data to
> work out what is happening in the chain of thought and how they can
> independently get to the same result.
>
> This is **not** distilling a model. Distillation trains a smaller model
> on the expert's weights. This asks the expert once, pays for it, keeps
> the **answer**, and lets a small model — or a rule engine — re-derive
> the same result from the ledger afterwards, with no new call and no
> new cost.

Until now a question was read against a **DOCUMENT**. The document was
the corpus, its hash was the correlation key, and a judge returned a
**number**, so the number was all there was to keep.

An expert is a different corpus and a different artefact. It answers in
**TEXT**, and the text is the thing that was paid for.

## The shape

A question's `state` may name an expert instead of carrying a document:

```js
{ id: "q:class", part: "premise", text: "...",
  state: { expert: { id: "counsel-tax-v2",
                     model: "gpt-x",
                     endpoint: "https://api.example/v1/chat" },
           ask: "You are tax counsel. Does a task record outrank a witness record?" } }
```

and the observation carries the whole expertship:

| column | what it is |
|---|---|
| `corpus` | `"document"` or `"expert"` — **derived from the state**, never taken on the caller's word |
| `expert` | `{id, model, endpoint}` — the named professional |
| `expertHash` | the correlation key: **who** it is, **without** the request |
| `request` | the exact request sent |
| `response` | the expert's answer, **verbatim** |
| `cost` | what it cost |
| `latencyMs` | how long it took |

Every one of the last five is `null` for a document reading, so a ledger
of documents produces a row-for-row identical ledger.

## Two hashes, and why there are two

This is the load-bearing detail and it is easy to get wrong.

| key | over | answers |
|---|---|---|
| `expertHash` | the expert's **identity** | *how many witnesses?* |
| `stateHash` | identity **+ the request** | *are these two readings samples of the same measurement?* |

If the request entered `expertHash`, then five different questions put to
one professional would come back as **five** distinct experts — and the
correlation signal would silently become a count of requests. Every
question would look like its own independent witness. That is precisely
the inversion `distinctStates` was invented to prevent, and it would be
worse for an expert than for a document, because an expert call is the
expensive one.

So the honest statement is the blunt one:

> **Five questions answered by one expert are five readings of one
> expert.** An expert is not five witnesses in a trenchcoat — it is one
> respondent whose priors, training data and blind spots every answer
> shares. Asking one expert five times buys a tighter estimate of *one
> opinion*, not five opinions.

Conversely, a different request to the same expert is a **different
measurement**, not another sample: the spread is not accumulated across
them.

## The correlation signal, generalised — and kept in two columns

`correlation(ledger, questionIds)` returns:

```js
{ questions: 5, documents: 1, experts: 2, expertIds: [...], caveat: "..." }
```

The two counts are **never averaged together**, and there is deliberately
no `sources: 3`. They are different kinds of dependence and they fail in
different ways: a document can be the wrong revision, while an expert can
be wrong *consistently* across every question. Combining them would hide
which kind is carrying the evidence.

And it stays a **count**, never a confidence — the same caveat the
document count has always carried, and now more sharply, because nothing
here checks that two named experts did not train on the same corpus:

> three documents are better than one only if the three are independent,
> and the graph **asserts** that — it does not verify it.

`sufficiency()` therefore **reports** the counts and does **not gate** on
them. Turning a count the design cannot support into a threshold would be
inventing a number, and inventing numbers is the thing this project does
not do.

## An expert nobody can name is refused

`defineGraph` throws on `{expert: {model: "gpt-x"}}` with no `id`, and
`recordObservation` throws on an `expert` with a blank `id`.

Two unnamed experts cannot be told apart, so the correlation count would
be a lie with **nothing to catch it**. This is refused at definition time
for the same reason an empty state is refused: an unnamed witness is
worse than no witness, because it looks like one.

## Sufficiency: is there enough yet?

> "JEV lets you know when you have enough questions to answer today's
> prompt."

`sufficiency(ledger, questionIds, {threshold, sourceThresholds})` answers
that, and it is derived **from the ledger** — no judge call, no expert
call, no network. That is the closure property: everything the answer
depends on is already recorded, so asking again buys nothing and costs
money.

It fails closed, in order, on: a **missing** observation (named, because
an absent observation is not a weak one), **unsafe** evidence
(`unreliable` / `contradicted`), a **batched** near-threshold reading
(needs isolation), a score that does **not clear** the threshold, and
finally the band below.

### The band, and the measurement it comes from

Measured — `docs/MEASURED-JUDGE-NOISE.md`, nine spec-reading claims, five
repeats each, the same document every time:

```
crossed the gate    : 0/45 = 0.0%
score spread        : mean 0.007   median 0.000   MAX 0.020
```

Reading only the `0/45` would be a mistake. It is zero because the claims
sat at 0.97–0.98 and 0.01–0.07, well clear of the gate. The one claim
that wobbled, `losers are listed`, scored
**0.910 0.920 0.930 0.920 0.910** — a spread of 0.020 sitting exactly in
the 0.9 band where the other agent measured their GO/OPEN flips.

> The score moves ~0.01–0.02 in general, and that is enough to push a
> score sitting near a threshold across it. **A score within ~0.02 of a
> threshold is a coin flip, even when every sample landed on the same
> side.**

So `NOISE_BAND = 0.02` is a **floor** on any sufficiency gate, taken from
a measurement rather than a preference. Two consequences:

- a deciding score inside the band is **NOT YET**, even when it has
  passed. The verdict is a string — `"sufficient"` or `"not-yet"` — and
  there is deliberately no third state that means "probably";
- the band is **raised by the question's own recorded spread** when it
  has one. A score we have watched wobble by 0.08 does not get the
  general band's 0.02 of patience.

The comparison carries an epsilon so the boundary fails closed: in binary
floating point `0.92 - 0.90` is `0.020000000000000018`, and "within
0.02" includes exactly 0.02.

**The caveat is in the API's output**, in the receipt and in the returned
object — not only in this file. A caller who reads `receipt` and nobody
else still learns the margin and the band it was judged against.

## What this does NOT do

- It does **not** make experts and documents comparable. Two sources are
  not interchangeable — that is why `sourceThresholds` exists — and a
  document count and an expert count are not numbers you may add.
- It does **not** verify that two named experts are independent. The count
  is reported with its caveat and is not gateable as a count.
- It does **not** replace a small model. It sets the standard; the small
  model's growth out of the metal, the user's optimisations and their
  tastes is the other half and does not live here.
- It does **not** call anything. `recordObservation` records an answer
  somebody already got; putting the call in the cell is the caller's
  business.

## Files

| file | what changed |
|---|---|
| `src/qgraph.mjs` | `isExpertState`, `expertOf`, `expertHash`, `assertCorpusIsWellFormed`, `graphHeader` carries the corpus |
| `src/ledger.mjs` | the extended observation record, `correlation`, `distinctExperts`, rows that carry the text |
| `src/derive.mjs` | `NOISE_BAND`, `NOISE_MEASUREMENT`, `sufficiency`, receipts that name the witnesses and the money |
| `test/expert.test.mjs` | 24 tests, each of which goes red without the behaviour it covers |
| `demo-expert.mjs` | two experts and one document, end to end |

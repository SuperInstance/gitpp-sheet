// A question may be read against a PAID EXPERT, not only a document.
//
// The corpus a question is scored against used to be a document. Now it
// may also be a named professional behind an API: you put the call in a
// cell, it does the job for a price, and the answer is TEXT.
//
// Three things have to survive that, and each one is tested here by
// something that goes RED when it is removed:
//
//   1. THE TEXT SURVIVES. A judge returns a number and the number is all
//      there is; an expert returns text, and the text is the thing that
//      was paid for. It has to survive the ledger AND the row round trip
//      verbatim, or the ledger is a log and not an artefact.
//   2. THE CORRELATION SIGNAL GENERALISES, AND STAYS SPLIT. Five
//      questions answered by the same expert are five readings of ONE
//      EXPERT, exactly as five questions over one document are five
//      readings of ONE DOCUMENT. Document count and expert count are
//      reported side by side and never averaged into one number.
//   3. SUFFICIENCY RESPECTS THE MEASURED NOISE. "JEV lets you know when
//      you have enough questions to answer today's prompt." It is
//      computed from the ledger with no new call, and a deciding score
//      sitting inside the measured 0.01-0.02 band is NOT YET, never a
//      guess -- even when it has passed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defineGraph, isExpertState, expertOf, expertHash, graphHeader,
} from "../src/qgraph.mjs";
import {
  createLedger, recordObservation, toRows, fromRows, readingsOf,
  distinctStates, distinctExperts, correlation, materialise, partStatus,
} from "../src/ledger.mjs";
import {
  deriveAnswer, verdictFromLedger, sufficiency, replayDecision,
  NOISE_BAND, NOISE_MEASUREMENT,
} from "../src/derive.mjs";
import { makeMockJudge } from "./support/jev-mock.mjs";

const SPEC = `SPEC. Class precedence is absolute: override > task > witness.`;

const fold = {
  state: { "config.timeout": 45, "env.load": 17 },
  setters: { "config.timeout": "req-2", "env.load": "req-1" },
  order: ["req-1", "req-2", "obs-1"],
  conflicts: [{ key: "config.timeout", winner: "req-2", losers: ["obs-1"] }],
  orphans: [],
};

// Two DIFFERENT professionals, plus one document. The distinction is
// load-bearing: the same expert asked five ways is one witness, two
// experts asked one way each are two.
const TAX = { id: "counsel-tax-v2", model: "gpt-x", endpoint: "https://api.example/v1/chat" };
const SEC = { id: "counsel-sec-v2", model: "gpt-x", endpoint: "https://api.example/v1/chat" };

const askTax = "As a tax counsel, does a task record outrank a witness record for the same key?";
const askSec = "As a securities counsel, is a late-filed witness record admissible for the same key?";
const askSec2 = "As a securities counsel, does a filed witness record bind the key it names?";

const RESPONSE = `Yes. A record of kind "task" outranks a record of kind "witness"
for the same key, and the witness loses regardless of the order the two
were filed in. -- counsel, 2026-02-01`;

function expertGraph() {
  return defineGraph({
    parts: [
      { id: "premise", statement: "A professional sets the standard for the order of records." },
      { id: "contest", statement: "req-2 outranks obs-1 for config.timeout.", dependsOn: ["premise"] },
    ],
    questions: [
      { id: "q:class", part: "premise", text: "A task record outranks a witness record for the same key.", state: { expert: TAX, ask: askTax }, weight: 1, bindsTo: ["config.timeout"] },
      { id: "q:tax", part: "premise", text: "A witness loses to a task for the same key.", state: { expert: TAX, ask: askTax }, weight: 0.5, bindsTo: ["config.timeout"] },
      { id: "q:late", part: "contest", text: "A late-filed witness is still a witness.", state: { expert: SEC, ask: askSec }, weight: 1, bindsTo: ["config.timeout"] },
      { id: "q:bind", part: "contest", text: "A witness record binds the key it names.", state: { expert: SEC, ask: askSec2 }, weight: 1, bindsTo: ["config.timeout"] },
      { id: "q:doc", part: "contest", text: "The document states that losers are listed.", state: { spec: SPEC }, weight: 1, bindsTo: ["config.timeout"] },
    ],
    decisions: [
      { id: "d:contest", part: "contest", requires: ["q:class", "q:tax", "q:late", "q:bind", "q:doc"], threshold: 0.90,
        action: "accept req-2 as the winner",
        decides: [{ key: "config.timeout", winner: "req-2", loser: "obs-1" }] },
    ],
  });
}

/** Record one expert answer the way a real cell would: the text back, the price, the clock. */
function askExpert(ledger, q, { score, verdict = "supported", response = RESPONSE, cost = 0.012, latencyMs = 1420 }) {
  return recordObservation(ledger, {
    q: q.id, score, verdict, mode: "solo", source: q.state.expert.id,
    state: q.state,
    request: q.state.ask,
    response,
    cost: { amount: cost, unit: "usd" },
    latencyMs,
  });
}

function expertLedger(graph, scores) {
  let L = createLedger(graph, fold);
  for (const [qid, score] of Object.entries(scores)) {
    const q = graph.questions.find((x) => x.id === qid);
    if (q.state.expert) L = askExpert(L, q, { score });
    else L = recordObservation(L, { q: qid, score, verdict: score > 0.5 ? "supported" : "not-supported", mode: "solo", state: q.state });
  }
  return L;
}

// ---------------------------------------------------------------------
// 1. THE RECORD CARRIES THE WHOLE EXPERTSHIP
// ---------------------------------------------------------------------

test("a question may be read against a NAMED EXPERT, and the record keeps the whole exchange", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.94 });
  const rec = L.observations.get("q:class");

  assert.equal(rec.corpus, "expert");
  assert.deepEqual(rec.expert, { id: "counsel-tax-v2", model: "gpt-x", endpoint: "https://api.example/v1/chat" });
  assert.equal(rec.request, askTax);
  // The TEXT is the artefact. It is kept verbatim -- newlines and all.
  assert.equal(rec.response, RESPONSE);
  assert.deepEqual(rec.cost, { amount: 0.012, unit: "usd" });
  assert.equal(rec.latencyMs, 1420);
});

test("the expert's TEXT survives the row round trip byte-for-byte", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.94, "q:late": 0.93 });
  const rows = toRows(L);
  assert.equal(rows[0].response, RESPONSE, "the raw rows carry the answer, not just the number");

  const rebuilt = fromRows(g, rows);
  const back = rebuilt.observations.get("q:class");
  assert.equal(back.response, RESPONSE);
  assert.equal(back.request, askTax);
  assert.deepEqual(back.cost, { amount: 0.012, unit: "usd" });
  assert.equal(back.latencyMs, 1420);
  assert.deepEqual(back.expert, { id: "counsel-tax-v2", model: "gpt-x", endpoint: "https://api.example/v1/chat" });
  assert.equal(back.expertHash, L.observations.get("q:class").expertHash);
});

test("a DOCUMENT reading is unchanged: the expert fields are null, not absent-and-guessed", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:doc": 0.95 });
  const rec = L.observations.get("q:doc");
  assert.equal(rec.corpus, "document");
  for (const k of ["expert", "expertHash", "request", "response", "cost", "latencyMs"]) {
    assert.equal(rec[k], null, `${k} is null for a document reading`);
  }
});

test("an expert nobody can name is REFUSED -- at definition time and at record time", () => {
  assert.throws(
    () => defineGraph({
      parts: [{ id: "p", statement: "s" }],
      questions: [{ id: "q:x", part: "p", text: "t", state: { expert: { model: "gpt-x" } } }],
      decisions: [],
    }),
    /expert with no usable id/,
    "an unnamed expert cannot be counted, so it is refused before it can be",
  );

  assert.throws(
    () => recordObservation(createLedger(expertGraph()), {
      q: "q:class", score: 0.9, state: { spec: SPEC }, expert: { id: "   " },
    }),
    /expert with no usable id/,
  );
});

test("one expert described two ways is ONE witness -- the descriptor is normalised", () => {
  assert.equal(
    expertHash({ id: "counsel-tax-v2" }),
    expertHash({ id: "counsel-tax-v2", model: undefined, endpoint: undefined }),
  );
  // but a different MODEL behind the same name is a different witness
  assert.notEqual(expertHash({ id: "a", model: "m1" }), expertHash({ id: "a", model: "m2" }));
});

test("the corpus is recognised from the state and never taken on trust from the caller", () => {
  assert.equal(isExpertState({ spec: SPEC }), false);
  assert.equal(isExpertState({ expert: TAX }), true);
  assert.equal(expertOf({ spec: SPEC }), null);
  assert.deepEqual(expertOf({ expert: TAX }), TAX);

  const g = expertGraph();
  let L = createLedger(g, fold);
  // A caller that CLAIMS the state is a document cannot make it one.
  L = recordObservation(L, {
    q: "q:class", score: 0.94, verdict: "supported", mode: "solo",
    state: g.questions[0].state, corpus: "document",
  });
  assert.equal(L.observations.get("q:class").corpus, "expert");
  assert.equal(graphHeader(g).questions.find((q) => q.id === "q:class").corpus, "expert");
  assert.equal(graphHeader(g).questions.find((q) => q.id === "q:doc").corpus, "document");
});

// ---------------------------------------------------------------------
// 2. THE CORRELATION SIGNAL GENERALISES, AND STAYS SPLIT
// ---------------------------------------------------------------------

test("five questions answered by ONE expert are five readings of ONE expert", () => {
  const g = defineGraph({
    parts: [{ id: "p", statement: "s" }],
    questions: [1, 2, 3, 4, 5].map((n) => ({
      id: `q:${n}`, part: "p", text: `A different question number ${n}.`,
      // FIVE DIFFERENT REQUESTS to the SAME expert.
      state: { expert: TAX, ask: `Ask ${n} of counsel-tax-v2.` },
    })),
    decisions: [],
  });
  let L = createLedger(g, fold);
  for (const q of g.questions) L = askExpert(L, q, { score: 0.94, response: `Answer ${q.id}.` });

  const ids = g.questions.map((q) => q.id);
  assert.equal(distinctExperts(L, ids), 1, "five requests, one respondent: ONE expert");
  assert.equal(distinctStates(L, ids), 0, "and not one document -- there was no document");
  // The naive count of distinct state hashes would say five, which is
  // precisely the lie this signal exists to prevent.
  assert.equal(new Set([...L.observations.values()].map((o) => o.stateHash)).size, 5);
});

test("TWO EXPERTS AND ONE DOCUMENT are counted SEPARATELY and never averaged together", () => {
  const g = expertGraph();
  const L = expertLedger(g, {
    "q:class": 0.94, "q:tax": 0.95,        // counsel-tax-v2  (twice)
    "q:late": 0.93, "q:bind": 0.94,        // counsel-sec-v2   (twice)
    "q:doc": 0.96,                         // the document
  });
  const ids = ["q:class", "q:tax", "q:late", "q:bind", "q:doc"];
  const c = correlation(L, ids);

  assert.equal(c.questions, 5);
  assert.equal(c.documents, 1);
  assert.equal(c.experts, 2);
  // The two kinds are separate fields, and neither is the sum of both.
  assert.notEqual(c.documents, c.experts);
  assert.notEqual(c.documents + c.experts, c.documents);
  assert.notEqual(c.documents + c.experts, c.experts);
  assert.deepEqual(c.expertIds, ["counsel-tax-v2", "counsel-sec-v2"]);

  // It is a COUNT with its caveat attached, never a confidence.
  assert.match(c.caveat, /counted SEPARATELY and never combined/);
  assert.match(c.caveat, /a COUNT, not a confidence/);
  assert.match(c.caveat, /ASSERTS the witnesses are independent and nothing here verifies it/);
});

test("the DOCUMENT count is unchanged for a ledger of documents, and never counts an expert", () => {
  // Half one: for documents, distinctStates is exactly what it always was --
  // the count of distinct document fingerprints, and nothing else.
  const g = expertGraph();
  const docOnly = expertLedger(g, { "q:doc": 0.96 });
  assert.equal(distinctStates(docOnly, ["q:doc"]), 1);
  assert.equal(
    distinctStates(docOnly, ["q:doc"]),
    new Set([...docOnly.observations.values()].map((o) => o.stateHash)).size,
  );

  // Half two: an expert's request hash is NOT a document. Without this,
  // one expensive expert answering five questions would look like five
  // independent witnesses -- the exact inversion of the signal.
  const mixed = expertLedger(g, { "q:doc": 0.96, "q:class": 0.94, "q:tax": 0.95 });
  assert.equal(distinctStates(mixed, ["q:doc", "q:class", "q:tax"]), 1);
  assert.equal(distinctExperts(mixed, ["q:doc", "q:class", "q:tax"]), 1);
});

test("a different request to the same expert is a different MEASUREMENT, not another sample", () => {
  const g = expertGraph();
  let L = createLedger(g, fold);
  const q = g.questions.find((x) => x.id === "q:class");
  L = recordObservation(L, { q: "q:class", score: 0.94, verdict: "supported", mode: "solo", state: q.state, request: askTax });
  L = recordObservation(L, { q: "q:class", score: 0.51, verdict: "supported", mode: "solo", state: q.state, request: "A DIFFERENT question of the same expert." });
  assert.equal(readingsOf(L, "q:class").length, 2, "both readings are kept");
  assert.equal(L.observations.get("q:class").spread, null, "but they are not samples OF EACH OTHER");
  // ...while a genuine repeat of the same request IS a sample.
  L = recordObservation(L, { q: "q:class", score: 0.95, verdict: "supported", mode: "solo", state: q.state, request: askTax });
  assert.ok(Math.abs(L.observations.get("q:class").spread - 0.01) < 1e-9);
});

test("the materialised cell and the part status both carry the two counts apart", () => {
  const g = expertGraph();
  const L = expertLedger(g, {
    "q:class": 0.94, "q:tax": 0.95, "q:late": 0.93, "q:bind": 0.94, "q:doc": 0.96,
  });
  const { sheet } = materialise(g, fold, L);
  const cell = sheet.byKey["config.timeout"];
  assert.equal(cell.distinctStates, 1);
  assert.equal(cell.distinctExperts, 2);

  const contest = partStatus(g, L).find((p) => p.id === "contest");
  assert.equal(contest.states, 1);
  assert.equal(contest.documents, 1);
  assert.equal(contest.experts, 1);   // q:late and q:bind are both counsel-sec-v2
});

// ---------------------------------------------------------------------
// 3. SUFFICIENCY, DERIVED FROM THE LEDGER AND BOUNDED BY THE NOISE
// ---------------------------------------------------------------------

test("sufficiency is derived from the LEDGER: no judge call, no expert call, nothing asked", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.94, "q:late": 0.93 });
  const historyBefore = L.history.length;
  const judge = makeMockJudge();

  const s = sufficiency(L, ["q:class", "q:late"], {
    threshold: 0.90, jev: judge, expert: () => { throw new Error("the gate must never call out"); },
  });

  assert.equal(judge.calls.length, 0, "no judge call");
  assert.equal(L.history.length, historyBefore, "and the ledger is not touched");
});

test("THE NOISE BAND: a score inside the measured band is NOT sufficient, even when it has passed", () => {
  // The measurement this is about: `losers are listed` scored
  // 0.910 0.920 0.930 0.920 0.910 -- a spread of 0.020 sitting exactly
  // in the 0.9 band where the other agent measured their GO/OPEN flips.
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.91, "q:late": 0.96 });

  const s = sufficiency(L, ["q:class", "q:late"], { threshold: 0.90 });
  assert.equal(s.sufficient, false);
  assert.equal(s.verdict, "not-yet");
  assert.equal(s.blocking, "inside-noise-band");
  assert.ok(s.margin <= NOISE_BAND, `margin ${s.margin} is inside the measured band`);
  assert.match(s.reason, /NOT YET/);
  assert.match(s.reason, /coin flip/);
  // and the pass itself is still true -- it is the SUFFICIENCY that refuses
  assert.equal(verdictFromLedger(L, ["q:class", "q:late"], 0.90).pass, true);
});

test("the band edge itself fails CLOSED: exactly 0.02 of margin is still not yet", () => {
  // In binary floating point 0.92 - 0.90 is 0.020000000000000018, so a
  // naive `<= 0.02` would let the edge through. "Within 0.02" includes
  // exactly 0.02.
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.92 });
  const onEdge = sufficiency(L, ["q:class"], { threshold: 0.90 });
  assert.equal(onEdge.sufficient, false);
  assert.equal(onEdge.blocking, "inside-noise-band");

  // and one notch wider it IS enough -- the gate is a gate, not a refusal
  const L2 = expertLedger(g, { "q:class": 0.94 });
  const clear = sufficiency(L2, ["q:class"], { threshold: 0.90 });
  assert.equal(clear.sufficient, true);
  assert.equal(clear.verdict, "sufficient");
  assert.equal(clear.blocking, null);
  assert.ok(clear.margin > NOISE_BAND);
});

test("a question's OWN recorded spread raises the band above the general one", () => {
  // Measured elsewhere: the same question against the same corpus gave
  // 0.290 / 0.360 / 0.370 -- a spread of 0.08. A score with a spread
  // that wide does not deserve the general band's 0.02 patience.
  const g = expertGraph();
  let L = createLedger(g, fold);
  const q = g.questions.find((x) => x.id === "q:class");
  L = recordObservation(L, { q: "q:class", score: 0.94, verdict: "supported", mode: "solo", state: q.state, request: askTax, spread: 0.08 });

  const s = sufficiency(L, ["q:class"], { threshold: 0.90 });
  // The margin is raw arithmetic -- 0.94 - 0.90 is 0.039999999999999925 --
  // so it is compared with a tolerance, the way this suite already
  // compares the 0.08 spread. The RECEIPT rounds it to three places.
  assert.ok(Math.abs(s.margin - 0.04) < 1e-9);
  assert.equal(s.sufficient, false, "0.04 is outside 0.02 but inside this question's own 0.08");
  assert.equal(s.effectiveBand, 0.08);
  assert.match(s.bandSource, /recorded spread/);
});

test("sufficiency FAILS CLOSED on a missing observation, and names it", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.94 });
  const s = sufficiency(L, ["q:class", "q:late"], { threshold: 0.90 });
  assert.equal(s.sufficient, false);
  assert.equal(s.blocking, "missing");
  assert.deepEqual(s.missing, ["q:late"]);
  assert.match(s.reason, /an absent one/);
});

test("sufficiency FAILS CLOSED on a batched near-threshold reading", () => {
  const g = expertGraph();
  let L = createLedger(g, fold);
  const q = g.questions.find((x) => x.id === "q:class");
  L = recordObservation(L, { q: "q:class", score: 0.55, verdict: "needs-isolation", mode: "batched", state: q.state, request: askTax });
  const s = sufficiency(L, ["q:class"], { threshold: 0.50 });
  assert.equal(s.sufficient, false);
  assert.deepEqual(s.needsIsolation, ["q:class"]);
});

test("sufficiency does NOT gate on the correlation count -- it is a count, not a confidence", () => {
  // Nothing here has verified that the experts are independent of each
  // other or of the document. Inventing an "independence score" out of
  // a count the design cannot support is the one thing this refuses to
  // do -- so ONE expert answering two questions with a wide margin is
  // still SUFFICIENT, and the caveat rides along in the output.
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.95, "q:tax": 0.94 });
  const s = sufficiency(L, ["q:class", "q:tax"], { threshold: 0.90 });
  assert.equal(s.experts, 1);
  assert.equal(s.sufficient, true);
  assert.match(s.correlation.caveat, /nothing here verifies it/);
});

test("THE NOISE CAVEAT IS IN THE OUTPUT, not only in the docs", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.94, "q:late": 0.93 });

  const ans = deriveAnswer(g, L, {
    id: "d:derived", requires: ["q:class", "q:late"], threshold: 0.90,
    assertedEdges: ["premise -> contest"],
  });

  // in the RECEIPT, which is the thing somebody acts on
  assert.match(ans.receipt, /Noise band 0\.020/);
  assert.match(ans.receipt, /max spread 0\.020 over 45 repeats/);
  // in the OBJECT, for a caller that never reads the receipt
  assert.equal(ans.noiseBand, NOISE_BAND);
  assert.equal(ans.sufficient, true);
  assert.equal(ans.insideNoiseBand, false);
  assert.equal(ans.sufficiency.noiseBand, 0.02);
  assert.match(ans.sufficiency.noiseMeasurement, /MEASURED-JUDGE-NOISE\.md/);
  assert.match(ans.sufficiency.noiseMeasurement, /MAX SPREAD 0\.020/);
  assert.match(NOISE_MEASUREMENT, /coin flip/);
});

test("the RECEIPT itself says NOT SUFFICIENT YET when the deciding score is inside the band", () => {
  // The requirement is that the API's OWN OUTPUT carries the caveat, and
  // a caller who reads only `receipt` must not be able to miss it.
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.91, "q:late": 0.96 });

  const ans = deriveAnswer(g, L, {
    id: "d:derived", requires: ["q:class", "q:late"], threshold: 0.90,
    assertedEdges: ["premise -> contest"],
  });

  assert.equal(ans.pass, true, "the gate passed -- and that is exactly the trap");
  assert.equal(ans.sufficient, false);
  assert.equal(ans.insideNoiseBand, true);
  assert.match(ans.receipt, /NOT SUFFICIENT YET/);
  assert.match(ans.receipt, /clears the threshold by 0\.010/);
  assert.match(ans.receipt, /coin flip that landed on the passing side/);
  assert.match(ans.receipt, /0\/45 gate crossings, max spread 0\.020/);
  // ...and the CERTIFIED/ASSERTED receipt is still whole underneath it.
  assert.match(ans.receipt, /2 CERTIFIED question/);
  assert.match(ans.receipt, /1 ASSERTED edge\(s\) nobody checked/);
});

// ---------------------------------------------------------------------
// 4. THE RECEIPT: CERTIFIED vs ASSERTED, and from whom
// ---------------------------------------------------------------------

test("a derived answer from an expert is a receipt: CERTIFIED, ASSERTED, and the money", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.94, "q:late": 0.93 });

  const ans = deriveAnswer(g, L, {
    id: "d:derived", requires: ["q:class", "q:late"], threshold: 0.90,
    assertedEdges: ["premise -> contest"],
  });

  assert.equal(ans.answered, true);
  // The distinction already exists in the graph and is not reinvented:
  // 2 CERTIFIED questions, 1 ASSERTED edge nobody checked.
  assert.match(ans.receipt, /2 CERTIFIED question/);
  assert.match(ans.receipt, /1 ASSERTED edge\(s\) nobody checked/);
  assert.equal(ans.certified, 2);
  assert.equal(ans.assertedEdges.length, 1);

  // and now it says WHICH WITNESS certified them, and what that cost
  assert.equal(ans.certifiedFrom.documents.length, 0);
  assert.deepEqual(ans.certifiedFrom.experts, ["q:class", "q:late"]);
  assert.deepEqual(ans.certifiedFrom.expertIds, ["counsel-tax-v2", "counsel-sec-v2"]);
  assert.equal(ans.expertSpend.calls, 2);
  assert.ok(Math.abs(ans.expertSpend.cost - 0.024) < 1e-9);
  assert.equal(ans.expertSpend.latencyMs, 1420);
});

test("the receipt names ONE expert as ONE witness, not two", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.95, "q:tax": 0.94 });
  const ans = deriveAnswer(g, L, {
    id: "d:derived", requires: ["q:class", "q:tax"], threshold: 0.90,
  });

  assert.equal(ans.experts, 1);
  assert.equal(ans.documents, 0);
  assert.match(ans.receipt, /1 expert\(s\) \(counsel-tax-v2\)/);
  assert.match(ans.receipt, /readings of ONE expert, not 2 independent witnesses/);
  assert.match(ans.receipt, /not five witnesses in a trenchcoat/);
});

test("the receipt reports the DOCUMENT count and the EXPERT count separately", () => {
  const g = expertGraph();
  const L = expertLedger(g, { "q:class": 0.95, "q:doc": 0.96 });
  const ans = deriveAnswer(g, L, {
    id: "d:derived", requires: ["q:class", "q:doc"], threshold: 0.90,
  });

  assert.equal(ans.documents, 1);
  assert.equal(ans.experts, 1);
  assert.equal(ans.states, 1, "states is still the document count, and always was");
  assert.match(ans.receipt, /read against 1 document\(s\) and 1 expert\(s\)/);
});

test("CLOSURE: an expert answer replays from the ledger with no call out, through the rows too", () => {
  const g = expertGraph();
  const L = expertLedger(g, {
    "q:class": 0.94, "q:tax": 0.95,        // counsel-tax-v2
    "q:late": 0.93, "q:bind": 0.94,        // counsel-sec-v2
    "q:doc": 0.96,                         // the document
  });

  const live = replayDecision(g, L, "d:contest");
  const rebuilt = fromRows(g, toRows(L));
  const replayed = replayDecision(g, rebuilt, "d:contest");

  assert.equal(replayed.confidence, live.confidence);
  assert.equal(replayed.pass, live.pass);
  assert.equal(replayed.confidence, 0.93);          // the MINIMUM, never a mean
  assert.equal(replayed.states, 1);                 // documents
  assert.equal(replayed.experts, 2);                // experts
  assert.equal(replayed.observations[0].response, RESPONSE,
    "and the professional's answer is still there after the round trip");
});

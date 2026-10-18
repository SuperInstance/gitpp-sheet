#!/usr/bin/env node
// A QUESTION READ AGAINST A PAID EXPERT, end to end.
//
// The document demo (demo-graph.mjs) reads every question against one
// document. This one reads the same chain of thought against THREE
// different corpora:
//
//   one DOCUMENT        what the spec says
//   two named EXPERTS   what a professional says, for a price
//
// and then answers four questions nobody asked, from the ledger alone,
// with no new call of any kind.
//
// The experts here are a MOCK, so the demo is deterministic and free.
// Nothing here calls a network. What is being demonstrated is the
// bookkeeping: that the professional's ANSWER survives, that the two
// kinds of dependence are counted separately, and that the gate refuses
// to call a score sufficient when it sits inside the measured noise.

import { defineGraph } from "./src/qgraph.mjs";
import { createLedger, recordObservation, correlation, distinctStates, distinctExperts, partStatus, toRows, fromRows } from "./src/ledger.mjs";
import { deriveAnswer, sufficiency, NOISE_BAND } from "./src/derive.mjs";

const rule = (s = "") => console.log(s);

// --- the corpora -------------------------------------------------------

const SPEC = `SPEC v0.4.6
5.1 Class precedence is absolute: override > task > witness.
5.4 Ties are broken by ancestry, then by topological order.`;

// Two DIFFERENT professionals. Not two personalities of one model: two
// endpoints, each with its own name, which is the whole point -- the
// correlation signal counts WITNESSES, not confidences.
const TAX = { id: "counsel-tax-v2", model: "gpt-x", endpoint: "https://api.example/v1/chat" };
const SEC = { id: "counsel-sec-v2", model: "gpt-x", endpoint: "https://api.example/v1/chat" };

const ASK = {
  tax: "You are tax counsel. Does a record of kind \"task\" outrank a record of kind \"witness\" for the same key?",
  tax2: "You are tax counsel. Does the loser of that contest appear in the record?",
  sec: "You are securities counsel. Is a witness record admissible for a key it does not name?",
  sec2: "You are securities counsel. Does a witness record bind the key it does name?",
};

const ANSWER = {
  tax: `Yes. A record of kind "task" outranks a record of kind "witness"
for the same key, under 5.1. The witness loses on class alone; the order of
filing is irrelevant. -- tax counsel, 2026-02-01`,
  sec: `No. A witness record is admissible only for a key it names. A witness
record naming another key is a general statement and does not settle the
contest. -- securities counsel, 2026-02-01`,
};

// --- 1. THE GRAPH ------------------------------------------------------
//
// The only new thing here is `state`. A question's state may be a
// document, or it may be a named expert plus the request to put to it.

const graph = defineGraph({
  parts: [
    { id: "premise", statement: "A professional sets the standard for the order of records." },
    { id: "contest", statement: "req-2 outranks obs-1 for config.timeout.", dependsOn: ["premise"] },
    { id: "apply", statement: "So req-2 is the setter of config.timeout.", dependsOn: ["contest"] },
  ],
  questions: [
    { id: "q:class", part: "premise", text: "A task record outranks a witness record for the same key.", state: { expert: TAX, ask: ASK.tax }, weight: 1, bindsTo: ["config.timeout"] },
    { id: "q:losers", part: "premise", text: "The loser of the contest appears in the record.", state: { expert: TAX, ask: ASK.tax2 }, weight: 0.4, bindsTo: ["config.timeout"] },
    { id: "q:admiss", part: "contest", text: "A witness record settles the key it names.", state: { expert: SEC, ask: ASK.sec }, weight: 1, bindsTo: ["config.timeout"] },
    { id: "q:binds", part: "contest", text: "A witness record binds the key it names.", state: { expert: SEC, ask: ASK.sec2 }, weight: 1, bindsTo: ["config.timeout"] },
    { id: "q:doc", part: "contest", text: "The document states the losers of a contest.", state: { spec: SPEC }, weight: 1, bindsTo: ["config.timeout"] },
  ],
  decisions: [
    { id: "d:contest", part: "contest", requires: ["q:class", "q:admiss", "q:binds", "q:doc"], threshold: 0.90, action: "accept req-2 as the winner" },
  ],
});

// --- 2. THE CALLS, AND WHAT THEY COST ----------------------------------
//
// Scores are MOCKED. Everything else -- the request, the answer, the
// price, the clock -- is recorded exactly as a real cell would record it,
// because that is the part that has to survive.

const SCORE = { "q:class": 0.94, "q:losers": 0.92, "q:admiss": 0.93, "q:binds": 0.93, "q:doc": 0.96 };
const PRICE = { "counsel-tax-v2": 0.012, "counsel-sec-v2": 0.009 };
const LATENCY = { "counsel-tax-v2": 1420, "counsel-sec-v2": 1180 };
// Which answer came back for which question. A real cell gets this from
// the response body; here it is a lookup so the demo stays deterministic.
const SAID = { "q:class": "tax", "q:losers": "tax", "q:admiss": "sec", "q:binds": "sec" };

let ledger = createLedger(graph, null);
let spend = 0;
for (const q of graph.questions) {
  const score = SCORE[q.id];
  if (q.state.expert) {
    const who = q.state.expert.id;
    spend += PRICE[who];
    ledger = recordObservation(ledger, {
      q: q.id, score, verdict: "supported", mode: "solo", source: who,
      state: q.state,
      request: q.state.ask,
      response: ANSWER[SAID[q.id]],
      cost: { amount: PRICE[who], unit: "usd" },
      latencyMs: LATENCY[who],
    });
  } else {
    ledger = recordObservation(ledger, { q: q.id, score, verdict: "supported", mode: "solo", state: q.state });
  }
}

rule("CORPUS OF EACH QUESTION");
rule("-----------------------");
for (const q of graph.questions) {
  const o = ledger.observations.get(q.id);
  rule(`  ${q.id.padEnd(9)} ${o.corpus.padEnd(9)} ${(o.expert ? o.expert.id : `doc ${o.stateHash.slice(7, 19)}`).padEnd(18)}` +
    ` score ${o.score.toFixed(2)}${o.cost ? `   ${o.cost.amount} usd   ${o.latencyMs} ms` : ""}`);
}
rule(`  total spent on the professionals: ${spend.toFixed(3)} usd`);

rule("\nWHAT THE PROFESSIONAL ACTUALLY SAID (kept verbatim)");
rule("---------------------------------------------------");
const answered = ledger.observations.get("q:class");
for (const line of answered.response.split("\n")) rule(`  | ${line}`);
rule(`  request : ${answered.request}`);
rule(`  witness : ${answered.expert.id} @ ${answered.expert.endpoint}`);

// --- 3. THE CORRELATION SIGNAL, COUNTED SEPARATELY ---------------------

rule("\nCORRELATION -- two kinds of dependence, never averaged");
rule("---------------------------------------------------------");
const ids = graph.questions.map((q) => q.id);
const c = correlation(ledger, ids);
rule(`  ${c.questions} question(s)  ->  ${c.documents} document(s)  +  ${c.experts} expert(s)`);
rule(`  documents : ${distinctStates(ledger, ids)}`);
rule(`  experts   : ${distinctExperts(ledger, ids)}   (${c.expertIds.join(", ")})`);
rule(`  ${c.caveat}`);
rule(`  q:class and q:losers are TWO questions and ONE expert (${answered.expert.id}).`);
rule(`  Reading either one is not independent evidence of the other.`);

// --- 4. SUFFICIENCY ----------------------------------------------------

rule("\nIS THERE ENOUGH? (derived from the ledger, no new call)");
rule("----------------------------------------------------------");
const wide = sufficiency(ledger, ["q:class", "q:admiss", "q:doc"], { threshold: 0.90 });
rule(`  margin ${wide.margin.toFixed(3)} vs noise band ${wide.noiseBand.toFixed(3)} -> ${wide.verdict.toUpperCase()}`);
rule(`  ${wide.reason}`);

// The same question set, with ONE score moved to 0.91 -- a passing score
// sitting 0.010 from the gate, which is inside the band that 45 repeats
// measured.
const tight = createLedger(graph, null);
let t2 = tight;
for (const q of graph.questions) {
  const score = q.id === "q:class" ? 0.91 : SCORE[q.id];
  if (q.state.expert) {
    t2 = recordObservation(t2, {
      q: q.id, score, verdict: "supported", mode: "solo", source: q.state.expert.id,
      state: q.state, request: q.state.ask, response: ANSWER[SAID[q.id]],
      cost: { amount: 0.012, unit: "usd" }, latencyMs: 1400,
    });
  } else {
    t2 = recordObservation(t2, { q: q.id, score, verdict: "supported", mode: "solo", state: q.state });
  }
}
const near = sufficiency(t2, ["q:class", "q:admiss", "q:doc"], { threshold: 0.90 });
rule(`\n  the same set, with one score moved to 0.91 (still PASSES the gate):`);
rule(`  margin ${near.margin.toFixed(3)} -> ${near.verdict.toUpperCase()}  [blocking: ${near.blocking}]`);
rule(`  ${near.reason}`);

// --- 5. THE RECEIPT ----------------------------------------------------

rule("\nRECEIPT -- a derived answer nobody asked for");
rule("--------------------------------------------");
const derived = deriveAnswer(graph, ledger, {
  id: "d:what-if-obs-1-were-a-task",
  requires: ["q:class", "q:admiss", "q:doc"],
  threshold: 0.90,
  assertedEdges: ["premise -> contest", "contest -> apply"],
});
for (const line of derived.receipt.split(/(?<=\.)\s+/)) rule(`  ${line}`);
rule("");
rule(`  certified from documents : ${derived.certifiedFrom.documents.join(", ") || "(none)"}`);
rule(`  certified from experts   : ${derived.certifiedFrom.expertIds.join(", ") || "(none)"}`);
rule(`  expert spend             : ${derived.expertSpend.calls} call(s), ${derived.expertSpend.cost.toFixed(3)} usd, slowest ${derived.expertSpend.latencyMs} ms`);

// --- 6. CLOSURE --------------------------------------------------------

rule("\nCLOSURE -- rebuild from the rows and ask again, with no call out");
rule("----------------------------------------------------------------");
const rebuilt = fromRows(graph, toRows(ledger));
rule(`  rows carry the answers : ${toRows(ledger).filter((r) => r.response).length} of ${toRows(ledger).length}`);
rule(`  the same correlation   : ${distinctExperts(rebuilt, ids)} expert(s), ${distinctStates(rebuilt, ids)} document(s)`);
rule(`  the same answer        : confidence ${derived.confidence.toFixed(2)}, sufficient ${sufficiency(rebuilt, ["q:class", "q:admiss", "q:doc"], { threshold: 0.90 }).sufficient}`);
rule(`  noise band in force    : ${NOISE_BAND} (max spread measured over 45 repeats)`);

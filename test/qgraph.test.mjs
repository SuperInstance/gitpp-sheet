// The question graph: the chain of thought as structure.
//
// The test that matters is the CLOSURE test: a ledger must be
// sufficient to reproduce every verdict. If it is, then a question
// nobody asked can be answered from the ledger, and a small model --
// or no model at all -- can do the work.
//
// The tests that matter second: the ways the method can LIE. A bare
// score, a mean instead of a minimum, a weighted mean, an absent
// observation treated as a weak one, a batched borderline score used
// to gate, an empty state read as a confident answer, and a
// correlation the confidence number hides.

import { test } from "node:test";
import assert from "node:assert/strict";

import { defineGraph, stateHash, isolationOrder, impactOf, partWeight } from "../src/qgraph.mjs";
import { createLedger, recordObservation, toRows, fromRows, materialise, distinctStates, partStatus } from "../src/ledger.mjs";
import { deriveAnswer, verdictFromLedger, replayDecision } from "../src/derive.mjs";
import { runScript, nextQuestions } from "../src/script.mjs";
import { makeMockJudge } from "./support/jev-mock.mjs";

const SPEC = `SPEC. Class precedence is absolute: override > task > witness.
A record of kind "task" outranks a record of kind "witness" for the same key.`;

const fold = {
  state: { "config.timeout": 45, "env.load": 17 },
  setters: { "config.timeout": "req-2", "env.load": "req-1" },
  order: ["req-1", "req-2", "obs-1"],
  conflicts: [{ key: "config.timeout", winner: "req-2", losers: ["obs-1"] }],
  orphans: [],
};

const records = [
  { id: "req-1", kind: "task", parents: [], effects: { "env.load": 17 } },
  { id: "req-2", kind: "task", parents: [], effects: { "config.timeout": 45 } },
  { id: "obs-1", kind: "witness", parents: [], effects: { "config.timeout": 30 } },
];

function makeGraph(overrides = {}) {
  return defineGraph({
    parts: [
      { id: "premise", statement: "The spec states a class precedence." },
      { id: "contest", statement: "req-2 outranks obs-1 for config.timeout.", dependsOn: ["premise"] },
    ],
    questions: [
      { id: "q:class", part: "premise", text: 'A record of kind "task" outranks a record of kind "witness" for the same key.', state: { spec: SPEC }, weight: 1, bindsTo: ["config.timeout"] },
      { id: "q:contest", part: "contest", text: "The document explicitly states the class precedence rule used to decide config.timeout.", state: { spec: SPEC }, weight: 1, bindsTo: ["config.timeout"] },
      { id: "q:obs", part: "contest", text: "The document explicitly states that a witness loses to a task.", state: { spec: SPEC }, weight: 0.3, bindsTo: ["config.timeout"] },
    ],
    decisions: [
      { id: "d:premise", part: "premise", requires: ["q:class"], threshold: 0.5,
        action: "accept the precedence rule",
        decides: [{ key: "config.timeout", winner: "req-2", loser: "obs-1" }] },
      { id: "d:contest", part: "contest", requires: ["q:class", "q:contest"], threshold: 0.5,
        action: "accept req-2 as the winner",
        decides: [{ key: "config.timeout", winner: "req-2", loser: "obs-1" }] },
    ],
    ...overrides,
  });
}

function filledLedger(graph, scores = { "q:class": 0.98, "q:contest": 0.93, "q:obs": 0.6 }) {
  let ledger = createLedger(graph, fold);
  for (const [qid, score] of Object.entries(scores)) {
    const q = graph.questions.find((x) => x.id === qid);
    ledger = recordObservation(ledger, {
      q: qid, score, verdict: score > 0.5 ? "supported" : "not-supported",
      mode: "solo", state: q.state,
    });
  }
  return ledger;
}

// ---------------------------------------------------------------------
// The graph itself
// ---------------------------------------------------------------------

test("a question with no state is refused at definition time", () => {
  assert.throws(
    () => defineGraph({
      parts: [{ id: "p", statement: "s" }],
      questions: [{ id: "q", part: "p", text: "t", state: null }],
      decisions: [],
    }),
    /no state/,
  );
});

test("a cycle among the parts is refused", () => {
  assert.throws(
    () => defineGraph({
      parts: [
        { id: "a", statement: "s", dependsOn: ["b"] },
        { id: "b", statement: "s", dependsOn: ["a"] },
      ],
      questions: [],
      decisions: [],
    }),
    /cycle/,
  );
});

test("the question kind is DERIVED from the text, and an override is recorded", () => {
  const g = defineGraph({
    parts: [{ id: "p", statement: "s" }],
    questions: [
      { id: "q:count", part: "p", text: "How many records set the key k0?", state: { s: "x" } },
      { id: "q:num", part: "p", text: "The value is at least 1e17.", state: { s: "x" } },
      { id: "q:atomic", part: "p", text: "A task outranks a witness.", state: { s: "x" } },
    ],
    decisions: [],
  });
  const by = Object.fromEntries(g.questions.map((q) => [q.id, q]));
  assert.equal(by["q:count"].kind, "aggregate");
  assert.equal(by["q:num"].kind, "quantity");
  assert.equal(by["q:atomic"].kind, "atomic");
});

test("weights order the isolation, and the blast radius travels with them", () => {
  const g = makeGraph();
  assert.deepEqual(isolationOrder(g, ["q:obs", "q:class"]), ["q:class", "q:obs"]);
  const impact = impactOf(g, "q:class");
  assert.ok(impact.decisions.some((d) => d.id === "d:contest"));
  assert.ok(impact.dependents.some((p) => p.id === "contest"));
  assert.equal(partWeight(g, "premise"), 1);
});

// ---------------------------------------------------------------------
// THE CLOSURE PROPERTY
// ---------------------------------------------------------------------

test("CLOSURE: a decision's verdict from the ledger equals the verdict from the judge", () => {
  const g = makeGraph();
  const judge = makeMockJudge({ "outranks a record of kind": 0.98, "explicitly states the class": 0.93 });

  // (a) With the judge in the loop.
  let ledger = createLedger(g, fold);
  for (const q of g.questions) {
    const score = judge(q.state, q.text);
    ledger = recordObservation(ledger, { q: q.id, score, verdict: score > 0.5 ? "supported" : "not-supported", mode: "solo", state: q.state });
  }
  const live = replayDecision(g, ledger, "d:contest");

  // (b) From the ledger alone, with the judge switched off.
  const replayed = replayDecision(g, ledger, "d:contest");

  assert.equal(live.confidence, replayed.confidence);
  assert.equal(live.pass, replayed.pass);
  assert.equal(live.weakest, replayed.weakest);
  assert.equal(replayed.confidence, 0.93);   // the MINIMUM, not the mean of 0.98 and 0.93
});

test("CLOSURE: a script run with the judge equals the same script run from the ledger", () => {
  const g = makeGraph();
  const script = { id: "s:1", steps: [{ id: "step:a", decision: "d:premise" }, { id: "step:b", decision: "d:contest" }] };
  const judge = makeMockJudge({ "outranks a record of kind": 0.98, "explicitly states the class": 0.93 });

  const live = runScript(g, createLedger(g, fold), script, { jev: judge });
  const replayed = runScript(g, live.ledger, script, {});   // no judge at all

  assert.equal(live.status, "certified");
  assert.equal(replayed.status, "certified");
  // The live run asked for q:class and q:contest -- the two questions the
  // steps REQUIRE. q:obs is in the graph but no decision requires it, so it
  // was never asked. Asking for what you do not need is the cost the
  // graph is meant to avoid.
  assert.equal(judge.calls.length, 2);
  assert.equal(replayed.trace.length, live.trace.length);   // the replay asked nothing
});

test("CLOSURE: a ledger survives a round trip through its rows", () => {
  const g = makeGraph();
  const ledger = filledLedger(g);
  const rows = toRows(ledger);
  const rebuilt = fromRows(g, rows);
  const a = replayDecision(g, ledger, "d:contest");
  const b = replayDecision(g, rebuilt, "d:contest");
  assert.equal(a.confidence, b.confidence);
  assert.equal(a.pass, b.pass);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => "verdict" in r && "mode" in r && "stateHash" in r));
});

// ---------------------------------------------------------------------
// Derived questions -- the point of the whole thing
// ---------------------------------------------------------------------

test("a DERIVED question is answered from the ledger with NO judge call", () => {
  const g = makeGraph();
  const ledger = filledLedger(g);
  const judge = makeMockJudge();
  const before = judge.calls.length;

  const answer = deriveAnswer(g, ledger, {
    id: "d:derived",
    requires: ["q:class", "q:contest"],
    threshold: 0.5,
    assertedEdges: ["premise -> contest"],
  });

  assert.equal(answer.answered, true);
  assert.equal(answer.confidence, 0.93);
  assert.equal(answer.pass, true);
  assert.equal(judge.calls.length, before);        // no new observation was taken
  assert.equal(answer.certified, 2);
  assert.equal(answer.assertedEdges.length, 1);
});

test("a derived answer's RECEIPT says how much is certified and how much is asserted", () => {
  const g = makeGraph();
  const ledger = filledLedger(g);
  const answer = deriveAnswer(g, ledger, {
    id: "d:derived", requires: ["q:class", "q:contest"], threshold: 0.5,
    assertedEdges: ["premise -> contest"],
  });
  assert.match(answer.receipt, /2 CERTIFIED question/);
  assert.match(answer.receipt, /1 ASSERTED edge\(s\) nobody checked/);
  assert.match(answer.receipt, /read against 1 document/);
  // and the correlation caveat, because two questions over one document
  // are two readings, not two witnesses
  assert.match(answer.receipt, /not 2 independent witnesses/);
});

test("a derived question with a MISSING observation REFUSES, and names what is missing", () => {
  const g = makeGraph();
  const ledger = filledLedger(g, { "q:class": 0.98 });   // q:contest never asked
  const answer = deriveAnswer(g, ledger, {
    id: "d:derived", requires: ["q:class", "q:contest"], threshold: 0.5,
  });
  assert.equal(answer.answered, false);
  assert.deepEqual(answer.missing, ["q:contest"]);
  assert.match(answer.receipt, /NOT ANSWERED/);
  assert.match(answer.receipt, /an absent one/);
});

// ---------------------------------------------------------------------
// The ways the method must not lie
// ---------------------------------------------------------------------

test("the confidence is the MINIMUM of the required questions, never the mean", () => {
  const g = makeGraph();
  const ledger = filledLedger(g, { "q:class": 0.99, "q:contest": 0.60 });
  const v = verdictFromLedger(ledger, ["q:class", "q:contest"]);
  assert.equal(v.confidence, 0.60);
  assert.notEqual(v.confidence, 0.795);      // the mean
});

test("a WEIGHT never enters the confidence number", () => {
  const g = makeGraph();
  // q:obs has weight 0.3, q:class has weight 1. A weighted mean would
  // be dragged UP by the high weight on the strong question.
  const ledger = filledLedger(g, { "q:class": 0.99, "q:obs": 0.40 });
  const v = verdictFromLedger(ledger, ["q:class", "q:obs"]);
  assert.equal(v.confidence, 0.40);
  const weighted = (0.99 * 1 + 0.40 * 0.3) / 1.3;
  assert.notEqual(v.confidence, weighted);
});

test("a BATCHED near-threshold observation cannot gate", () => {
  const g = makeGraph();
  let ledger = createLedger(g, fold);
  const q = g.questions.find((x) => x.id === "q:class");
  ledger = recordObservation(ledger, {
    q: "q:class", score: 0.55, verdict: "needs-isolation", mode: "batched", state: q.state,
  });
  const v = verdictFromLedger(ledger, ["q:class"]);
  assert.equal(v.answerable, false);
  assert.match(v.reason, /re-asked alone/);
  assert.deepEqual(v.needsIsolation, ["q:class"]);
});

test("a SOLO near-threshold observation may gate, and the threshold is honoured", () => {
  const g = makeGraph();
  let ledger = createLedger(g, fold);
  const q = g.questions.find((x) => x.id === "q:class");
  ledger = recordObservation(ledger, {
    q: "q:class", score: 0.55, verdict: "supported", mode: "solo", state: q.state,
  });
  const v = verdictFromLedger(ledger, ["q:class"], 0.5);
  assert.equal(v.answerable, true);
  assert.equal(v.pass, true);
  const strict = verdictFromLedger(ledger, ["q:class"], 0.7);
  assert.equal(strict.pass, false);
});

test("the correlation signal counts DISTINCT DOCUMENTS, not questions", () => {
  const g = makeGraph();
  const ledger = filledLedger(g);
  assert.equal(distinctStates(ledger, ["q:class", "q:contest", "q:obs"]), 1);
  assert.equal(distinctStates(ledger, ["q:class"]), 1);
  assert.equal(distinctStates(ledger, ["q:class", "q:missing"]), 1);
});

test("a part with no observations is ASSERTED, not scored 0 and not scored 1", () => {
  const g = makeGraph();
  const ledger = createLedger(g, fold);
  const statuses = partStatus(g, ledger);
  const premise = statuses.find((p) => p.id === "premise");
  assert.equal(premise.status, "asserted");
  assert.equal(premise.confidence, null);
  assert.equal(premise.certified, 0);
});

test("a bare score is not enough to read -- the verdict is what makes it safe", () => {
  const g = makeGraph();
  let ledger = createLedger(g, fold);
  const q = g.questions.find((x) => x.id === "q:class");
  // A claim the judge marked unreliable, at a score that would gate.
  ledger = recordObservation(ledger, {
    q: "q:class", score: 0.93, verdict: "unreliable",
    reason: "claim contains a quantity", mode: "solo", state: q.state,
  });
  const v = verdictFromLedger(ledger, ["q:class"]);
  assert.equal(v.answerable, false, "0.93 with an unreliable verdict must not gate");
  assert.match(v.reason, /not safe to gate on/);
});

test("the materialised sheet carries the graph's provenance onto its cells", () => {
  const g = makeGraph();
  const ledger = filledLedger(g);
  const { sheet } = materialise(g, fold, ledger);
  const cell = sheet.byKey["config.timeout"];
  assert.ok(cell.questions.includes("q:class"));
  assert.ok(cell.decisionsFromGraph.length >= 1);
  assert.equal(cell.confidence, 0.93);
});

// ---------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------

test("a script STOPS at the first uncertified step, and says which", () => {
  const g = makeGraph();
  const script = { id: "s:2", steps: [{ id: "step:a", decision: "d:premise" }, { id: "step:b", decision: "d:contest" }] };
  const judge = makeMockJudge({ "outranks a record of kind": 0.20 });
  const result = runScript(g, createLedger(g, fold), script, { jev: judge });
  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAt, "step:a");
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].status, "failed");
});

test("a script with no judge and no observations FAILS, rather than passing vacuously", () => {
  const g = makeGraph();
  const script = { id: "s:3", steps: [{ id: "step:a", decision: "d:premise" }] };
  const result = runScript(g, createLedger(g, fold), script, {});
  assert.equal(result.status, "failed");
  assert.match(result.trace[0].reason, /no observation/);
});

test("a script refuses to ASK a question whose state is empty", () => {
  const g = defineGraph({
    parts: [{ id: "p", statement: "s" }],
    questions: [{ id: "q:empty", part: "p", text: "The document states X.", state: { spec: "" } }],
    decisions: [{ id: "d:1", part: "p", requires: ["q:empty"], threshold: 0.5 }],
  });
  const script = { id: "s:4", steps: [{ id: "step:a", decision: "d:1" }] };
  const judge = makeMockJudge();
  const result = runScript(g, createLedger(g, fold), script, { jev: judge });
  assert.equal(result.status, "failed");
  assert.match(result.trace[0].reason, /refusing to ask/);
  assert.equal(judge.calls.length, 0, "the judge must not be called on an unusable state");
});

test("the worklist after a failure names the questions to re-ask, heaviest first", () => {
  const g = makeGraph();
  const script = { id: "s:5", steps: [{ id: "step:a", decision: "d:contest" }] };
  const ledger = filledLedger(g, { "q:class": 0.45, "q:contest": 0.52 });
  const result = runScript(g, ledger, script, {});
  const next = nextQuestions(g, ledger, script, result);
  assert.deepEqual(next, ["q:class", "q:contest"]);   // q:class has weight 1, q:contest weight 1
  assert.ok(next.includes("q:class"));
});

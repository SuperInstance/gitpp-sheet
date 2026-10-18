#!/usr/bin/env node
// The chain of thought as a graph of questions, end to end.
//
// The judge here is a MOCK, so the demo is deterministic and costs
// nothing. The live judge is exercised by the `live` CI job, which is
// separate on purpose: a live-API failure must not be able to mask a
// unit failure, and the unit suite must not need the network.
//
// What this shows:
//
//   1. A BIG MODEL'S JOB: author the script -- the parts, the
//      questions, the edges, the weights.
//   2. THE JUDGE'S JOB: answer the questions against a document.
//   3. THE SCRIPT'S JOB: run the steps, stop at the first one that is
//      not certified.
//   4. THE LEDGER'S JOB: keep the observations, so that a question
//      NOBODY ASKED can be answered afterwards with no new judge call.
//
// Step 4 is the point of the whole design.

import { defineGraph } from "./src/qgraph.mjs";
import { createLedger, materialise, toRows, partStatus } from "./src/ledger.mjs";
import { deriveAnswer, replayDecision } from "./src/derive.mjs";
import { runScript, nextQuestions } from "./src/script.mjs";
import { makeMockJudge } from "./test/support/jev-mock.mjs";

// --- the document the judge reads -------------------------------------
const SPEC = `SPEC v0.4.6
5.1 Class precedence is absolute: override > task > witness.
    A record of kind "task" outranks a record of kind "witness" for the
    same key.
5.4 Ties are broken by ancestry, then by topological order.`;

// --- the records and the fold ------------------------------------------
const records = [
  { id: "req-2", kind: "task", parents: [], effects: { "config.timeout": 45 } },
  { id: "obs-1", kind: "witness", parents: [], effects: { "config.timeout": 30 } },
  { id: "req-1", kind: "task", parents: [], effects: { "env.load": 17 } },
];
const fold = {
  state: { "config.timeout": 45, "env.load": 17 },
  setters: { "config.timeout": "req-2", "env.load": "req-1" },
  order: ["req-1", "req-2", "obs-1"],
  conflicts: [{ key: "config.timeout", winner: "req-2", losers: ["obs-1"] }],
  orphans: [],
};

// --- 1. THE BIG MODEL WRITES THE SCRIPT --------------------------------
//
// Parts are the steps of the reasoning. Questions are the things that
// can be CHECKED. The edges between parts are ASSERTED -- authored, not
// certified -- and the receipt will say so.
const graph = defineGraph({
  parts: [
    { id: "premise", statement: "The spec states a class precedence." },
    { id: "contest", statement: "req-2 outranks obs-1 for config.timeout.", dependsOn: ["premise"] },
    { id: "apply", statement: "So req-2 is the setter of config.timeout.", dependsOn: ["contest"] },
  ],
  questions: [
    {
      id: "q:precedence", part: "premise", weight: 1, bindsTo: ["config.timeout"],
      text: 'The document explicitly states that a record of kind "task" outranks a record of kind "witness" for the same key.',
      state: { spec: SPEC },
    },
    {
      id: "q:contest", part: "contest", weight: 1, bindsTo: ["config.timeout"],
      text: "The document explicitly states the class precedence rule that decides config.timeout.",
      state: { spec: SPEC },
    },
    {
      id: "q:ancestry", part: "contest", weight: 0.3, bindsTo: ["config.timeout"],
      text: "The document explicitly states how a tie between two records of the same class is broken.",
      state: { spec: SPEC },
    },
    {
      id: "q:apply", part: "apply", weight: 1, bindsTo: ["config.timeout"],
      text: "The document explicitly states that the highest-ranked record for a key sets that key's value.",
      state: { spec: SPEC },
    },
  ],
  decisions: [
    {
      id: "d:premise", part: "premise", requires: ["q:precedence"], threshold: 0.5,
      action: "accept the precedence rule",
      decides: [{ key: "config.timeout", winner: "req-2", loser: "obs-1" }],
    },
    {
      id: "d:contest", part: "contest", requires: ["q:precedence", "q:contest"], threshold: 0.5,
      action: "accept req-2 as the winner of config.timeout",
      decides: [{ key: "config.timeout", winner: "req-2", loser: "obs-1" }],
    },
    {
      id: "d:apply", part: "apply", requires: ["q:contest", "q:apply"], threshold: 0.5,
      action: "apply req-2 to config.timeout",
    },
  ],
});

const script = {
  id: "s:apply-req-2",
  steps: [
    { id: "step:premise", decision: "d:premise" },
    { id: "step:contest", decision: "d:contest" },
    { id: "step:apply", decision: "d:apply" },
  ],
};

// --- 2. THE JUDGE ANSWERS ----------------------------------------------
const judge = makeMockJudge({
  "outranks a record of kind": 0.97,
  "explicitly states the class precedence rule": 0.94,
  "the highest-ranked record for a key sets": 0.91,
  "how a tie between two records": 0.41,      // near the gate, on purpose
});

console.log("SCRIPT");
console.log("======");
for (const s of script.steps) {
  const d = graph.decisions.find((x) => x.id === s.decision);
  console.log(`  ${s.id.padEnd(14)} -> ${d.action}`);
}

console.log("\nRUN 1 -- with the judge in the loop");
console.log("------------------------------");
const first = runScript(graph, createLedger(graph, fold), script, { jev: judge });
for (const t of first.trace) {
  if (t.status === "observed") {
    console.log(`  ${t.step.padEnd(14)} observed ${t.question} = ${t.score} (${t.verdict})`);
  } else {
    console.log(`  ${t.step.padEnd(14)} ${t.status.toUpperCase()}` +
      (t.confidence !== undefined ? `  confidence ${t.confidence.toFixed(2)} / ${t.threshold.toFixed(2)}` : "") +
      (t.states ? `  ${t.states} document(s)` : ""));
  }
}
console.log(`  => ${first.status.toUpperCase()}${first.stoppedAt ? ` (stopped at ${first.stoppedAt})` : ""}`);
console.log(`  the judge was called ${judge.calls.length} time(s)`);

// --- 3. THE LEDGER ------------------------------------------------------
const ledger = first.ledger;
console.log("\nLEDGER");
console.log("------");
for (const r of toRows(ledger)) {
  console.log(`  ${r.q.padEnd(14)} score ${String(r.score).padEnd(5)} verdict ${String(r.verdict).padEnd(18)} ${r.mode} ${r.stateHash.slice(0, 18)}...`);
}
console.log("\nPARTS");
console.log("-----");
for (const p of partStatus(graph, ledger)) {
  console.log(`  ${p.id.padEnd(9)} ${p.status.padEnd(24)} confidence ${p.confidence === null ? "  n/a" : p.confidence.toFixed(2)}` +
    `  weight mass ${p.weightMass.toFixed(1)}  ${p.states} document(s)` +
    (p.dependsOn.length ? `  depends on ${p.dependsOn.join(", ")}` : ""));
}

// --- 4. A QUESTION NOBODY ASKED ----------------------------------------
//
// "Would obs-1 have won if it had been a task?" needs the SAME
// observations, recombined. No new judge call.
console.log("\nDERIVED -- a question nobody asked");
console.log("----------------------------------");
const derived = deriveAnswer(graph, ledger, {
  id: "d:what-if-obs-1-were-a-task",
  requires: ["q:precedence", "q:contest"],
  threshold: 0.5,
  assertedEdges: ["premise -> contest", "contest -> apply"],
});
console.log(`  ${derived.receipt}`);

const before = judge.calls.length;
const replay = replayDecision(graph, ledger, "d:contest");
console.log(`\n  replayed d:contest from the ledger: confidence ${replay.confidence.toFixed(2)}, pass ${replay.pass}`);
console.log(`  the judge was called ${judge.calls.length - before} time(s) during the replay`);

// --- 5. AND THE FAILURE PATHS -----------------------------------------
//
// Two ways the method says NO, and both of them are refusals rather
// than guesses.
console.log("\nREFUSAL 1 -- a question nobody observed");
console.log("---------------------------------------");
const unobserved = deriveAnswer(graph, ledger, {
  id: "d:needs-the-ancestry-rule",
  requires: ["q:precedence", "q:ancestry"],   // q:ancestry was never asked
  threshold: 0.5,
});
console.log(`  answered: ${unobserved.answered}`);
console.log(`  receipt : ${unobserved.receipt}`);

console.log("\nREFUSAL 2 -- a near-threshold answer that was asked in a batch");
console.log("---------------------------------------------------------------");
let batched = ledger;
batched = {
  ...batched,
  observations: new Map(batched.observations),
  history: [...batched.history],
};
batched.observations.set("q:ancestry", {
  q: "q:ancestry", score: 0.55, verdict: "supported", mode: "batched",
  stateHash: batched.observations.get("q:precedence").stateHash,
  state: { spec: SPEC }, at: null,
});
batched.history.push(batched.observations.get("q:ancestry"));
const batchedAnswer = deriveAnswer(graph, batched, {
  id: "d:needs-the-ancestry-rule", requires: ["q:precedence", "q:ancestry"], threshold: 0.5,
});
console.log(`  answered: ${batchedAnswer.answered}`);
console.log(`  receipt : ${batchedAnswer.receipt}`);
console.log(`  re-ask, heaviest first: ${(batchedAnswer.needsIsolation ?? []).join(", ") || "(none)"}`);

// --- 6. THE SHEET -------------------------------------------------------
console.log("\nSHEET");
console.log("-----");
const { sheet } = materialise(graph, fold, ledger);
for (const c of sheet.cells) {
  console.log(`  ${c.key.padEnd(16)} ${String(c.value).padEnd(6)} setter ${String(c.setter).padEnd(6)} ` +
    `confidence ${c.confidence.toFixed(2)}  questions ${c.questions.join(",") || "(none)"}`);
}

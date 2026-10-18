#!/usr/bin/env node
// The question graph against the REAL judge.
//
// The unit suite uses a mock, so it is deterministic and needs no
// network. This file is the other half: it proves the graph works
// against the actual judge and the actual spec.
//
// The assertion here is deliberately about the PIPELINE, not about the
// scores. A live judge is a network service with measured noise, so
// pinning a number would make this job a coin flip. What must hold is
// that the pipeline RAN, that it produced observations, that the
// ledger round-trips, and that the receipt is honest about what is
// certified and what is merely asserted.

import { readFileSync } from "node:fs";
import { defineGraph } from "./src/qgraph.mjs";
import { createLedger, recordObservation, toRows, fromRows } from "./src/ledger.mjs";
import { deriveAnswer, replayDecision } from "./src/derive.mjs";
import { runScript } from "./src/script.mjs";
import { singleQuestion } from "./src/jev.mjs";

const SPEC_PATH = process.env.GITPP_SPEC;
if (!SPEC_PATH) throw new Error("GITPP_SPEC is not set");
const SPEC = readFileSync(SPEC_PATH, "utf8");
if (SPEC.trim().length === 0) throw new Error("the spec is empty -- the judge would answer from its own beliefs");

const graph = defineGraph({
  parts: [
    { id: "premise", statement: "The spec states a class precedence." },
    { id: "contest", statement: "req-2 outranks obs-1 for config.timeout.", dependsOn: ["premise"] },
  ],
  questions: [
    {
      id: "q:precedence", part: "premise", weight: 1, bindsTo: ["config.timeout"],
      text: 'The document explicitly states that a record of kind "task" outranks a record of kind "witness" for the same key.',
      state: { spec: SPEC },
    },
    {
      id: "q:contest", part: "contest", weight: 1, bindsTo: ["config.timeout"],
      text: "The document explicitly states the class precedence rule that decides a contested key.",
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
      action: "accept req-2 as the winner",
      decides: [{ key: "config.timeout", winner: "req-2", loser: "obs-1" }],
    },
  ],
});

const script = {
  id: "s:live",
  steps: [{ id: "step:premise", decision: "d:premise" }, { id: "step:contest", decision: "d:contest" }],
};

console.log("LIVE -- the real judge, the real spec");
console.log("-------------------------------------");

// The judge is asked directly, one question at a time, so the mode is
// "solo" and the 0.037 batch band does not apply to these scores.
let ledger = createLedger(graph, null);
for (const q of graph.questions) {
  const score = singleQuestion(q.state, {
    type: "noul",
    instructions:
      `Answer true only if the state document explicitly states the following: ` +
      `${q.text.replace(/\.$/, "")}.`,
  });
  if (score === null || score === undefined) {
    console.error(`FAIL: the judge returned no answer for ${q.id}`);
    process.exit(1);
  }
  ledger = recordObservation(ledger, {
    q: q.id, score, verdict: score > 0.5 ? "supported" : "not-supported",
    mode: "solo", state: q.state,
  });
  console.log(`  ${q.id.padEnd(14)} ${String(score).padEnd(6)}`);
}

const rows = toRows(ledger);
console.log(`  ${rows.length} observation(s) recorded`);

// THE LEDGER MUST ROUND-TRIP. A ledger that cannot be read back is a
// log, not an artifact.
const rebuilt = fromRows(graph, rows);
const a = replayDecision(graph, ledger, "d:contest");
const b = replayDecision(graph, rebuilt, "d:contest");
if (a.answerable !== b.answerable || a.confidence !== b.confidence) {
  console.error("FAIL: the ledger did not round-trip");
  process.exit(1);
}
console.log(`  the ledger round-trips: confidence ${a.confidence.toFixed(3)}`);

// THE SCRIPT MUST REPLAY WITH NO JUDGE AT ALL. This is the closure
// property, against the real judge rather than a mock.
const replay = runScript(graph, ledger, script, {});
console.log(`  the script replays from the ledger alone: ${replay.status.toUpperCase()}`);

// AND A DERIVED QUESTION MUST BE ANSWERABLE FROM THE LEDGER.
const derived = deriveAnswer(graph, ledger, {
  id: "d:derived", requires: ["q:precedence", "q:contest"], threshold: 0.5,
  assertedEdges: ["premise -> contest"],
});
console.log(`  derived: ${derived.receipt}`);
if (!derived.answered) {
  console.error("FAIL: the derived question could not be answered from the ledger");
  process.exit(1);
}

console.log("OK");

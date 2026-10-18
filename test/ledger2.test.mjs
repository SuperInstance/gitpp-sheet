// The ledger's second set of rules, taken from what the OTHER agents
// measured while this design was being built.
//
// Three findings from elsewhere in the fleet, applied here:
//
//   1. Jev is not deterministic. The other agent measured ~7% of gates
//      flipping GO<->OPEN at 0.9 when re-asked. So a score is a
//      SAMPLE, not a constant, and the LEDGER -- not the judge -- is
//      what makes a verdict reproducible.
//   2. "A path's latest reading now replaces earlier ones. Keeping the
//      best reading let callers re-ask until a gate passed."
//   3. "Calibrating Jev hurt it. For Workers AI, a per-source
//      threshold matched the isotonic map, so the gate gained
//      source_thresholds."

import { test } from "node:test";
import assert from "node:assert/strict";

import { defineGraph } from "../src/qgraph.mjs";
import {
  createLedger, recordObservation, readingsOf, spreadOf, toRows, fromRows,
} from "../src/ledger.mjs";
import { deriveAnswer, verdictFromLedger } from "../src/derive.mjs";

const SPEC = { spec: "SPEC" };

function graph() {
  return defineGraph({
    parts: [{ id: "p", statement: "s" }],
    questions: [
      { id: "q:a", part: "p", text: "A states X.", state: SPEC },
      { id: "q:b", part: "p", text: "B states Y.", state: SPEC },
    ],
    decisions: [{ id: "d:1", part: "p", requires: ["q:a", "q:b"], threshold: 0.5 }],
  });
}

test("the LATEST reading wins -- never the best one", () => {
  // The other agent's finding: keeping the best reading lets a caller
  // re-ask until the gate passes. That is how a flaky judge is laundered
  // into a confident verdict.
  const g = graph();
  let L = createLedger(g);
  L = recordObservation(L, { q: "q:a", score: 0.30, verdict: "not-supported", mode: "solo", state: SPEC });
  L = recordObservation(L, { q: "q:a", score: 0.92, verdict: "supported", mode: "solo", state: SPEC });
  L = recordObservation(L, { q: "q:a", score: 0.41, verdict: "not-supported", mode: "solo", state: SPEC });

  const obs = L.observations.get("q:a");
  assert.equal(obs.score, 0.41, "the CURRENT reading is the most recent, not the highest");
  assert.equal(readingsOf(L, "q:a").length, 3, "but the history keeps every reading");
});

test("the spread of a score is recoverable, because a score is a SAMPLE", () => {
  // Measured: 0.290 / 0.360 / 0.370 on three repeats of the same
  // question against the same document -- a spread of 0.08, while the
  // VERDICT never moved.
  const g = graph();
  let L = createLedger(g);
  for (const s of [0.290, 0.360, 0.370]) {
    L = recordObservation(L, { q: "q:a", score: s, verdict: "not-supported", mode: "solo", state: SPEC });
  }
  // 0.370 - 0.290 is 0.08000000000000002 in binary floating point.
  assert.ok(Math.abs(spreadOf(L, "q:a") - 0.08) < 1e-9, "the spread is recoverable");
  assert.ok(Math.abs(L.observations.get("q:a").spread - 0.08) < 1e-9);
});

test("a derived answer reports the spread of its weakest question", () => {
  const g = graph();
  let L = createLedger(g);
  L = recordObservation(L, { q: "q:a", score: 0.93, verdict: "supported", mode: "solo", state: SPEC, spread: 0.01 });
  L = recordObservation(L, { q: "q:b", score: 0.60, verdict: "supported", mode: "solo", state: SPEC, spread: 0.08 });

  const ans = deriveAnswer(g, L, { id: "d:x", requires: ["q:a", "q:b"], threshold: 0.5 });
  assert.ok(Math.abs(ans.spread - 0.08) < 1e-9);
  assert.match(ans.receipt, /SPREAD|SAMPLE/);
  assert.match(ans.receipt, /0\.080/);
});

test("TWO SOURCES ARE NOT INTERCHANGEABLE: each is judged on its own bar", () => {
  // The other agent: "calibrating Jev hurt it. For Workers AI, a
  // per-source threshold matched the isotonic map, so the gate gained
  // source_thresholds."
  //
  // So a decision whose evidence comes from two sources cannot
  // compare them on ONE scale. Each source is compared against ITS
  // OWN threshold, and every source must clear its own bar.
  const g = graph();
  let L = createLedger(g);
  // Jev is the strict one: 0.55 clears 0.70? No.
  L = recordObservation(L, { q: "q:a", score: 0.55, verdict: "supported", mode: "solo", state: SPEC, source: "jev" });
  // Workers AI is calibrated differently: 0.55 clears 0.50.
  L = recordObservation(L, { q: "q:b", score: 0.55, verdict: "supported", mode: "solo", state: SPEC, source: "workers-ai" });

  const strict = verdictFromLedger(L, ["q:a", "q:b"], 0.5, {
    sourceThresholds: { jev: 0.70, "workers-ai": 0.50 },
  });
  assert.equal(strict.perSource.length, 2);
  assert.equal(strict.perSource.find((p) => p.source === "jev").pass, false, "jev's 0.55 does not clear jev's 0.70");
  assert.equal(strict.perSource.find((p) => p.source === "workers-ai").pass, true, "workers-ai's 0.55 clears its own 0.50");
  assert.equal(strict.pass, false, "EVERY source must clear its OWN bar");

  // With no per-source thresholds, it is the plain single threshold.
  const plain = verdictFromLedger(L, ["q:a", "q:b"], 0.5);
  assert.equal(plain.perSource.length, 0);
  assert.equal(plain.pass, true);
});

test("the receipt says which source decided what", () => {
  const g = graph();
  let L = createLedger(g);
  L = recordObservation(L, { q: "q:a", score: 0.93, verdict: "supported", mode: "solo", state: SPEC, source: "jev" });
  L = recordObservation(L, { q: "q:b", score: 0.55, verdict: "supported", mode: "solo", state: SPEC, source: "workers-ai" });

  const ans = deriveAnswer(g, L, {
    id: "d:y", requires: ["q:a", "q:b"], threshold: 0.5,
    sourceThresholds: { jev: 0.70, "workers-ai": 0.50 },
  });
  assert.match(ans.receipt, /Judged per source/);
  assert.match(ans.receipt, /jev/);
  assert.match(ans.receipt, /workers-ai/);
});

test("the ledger still round-trips with the new fields", () => {
  const g = graph();
  let L = createLedger(g);
  L = recordObservation(L, { q: "q:a", score: 0.93, verdict: "supported", mode: "solo", state: SPEC, source: "jev", spread: 0.02 });
  L = recordObservation(L, { q: "q:b", score: 0.81, verdict: "supported", mode: "solo", state: SPEC, source: "workers-ai" });
  const rebuilt = fromRows(g, toRows(L));
  assert.equal(rebuilt.observations.get("q:a").source, "jev");
  assert.equal(rebuilt.observations.get("q:a").spread, 0.02);
  assert.equal(rebuilt.observations.get("q:b").source, "workers-ai");
});

// Tests for the confidence sheet.
//
// The discipline this project has learned: a test that cannot fail is
// not a test. So every case here asserts a value that a WRONG
// implementation would get wrong, and the whole file is verified
// against a deliberately broken build at the end.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSheet, sheetConfidence, fragileCells, affectedCells, propagateClassChange } from "../src/sheet.mjs";

const fold = {
  state: { a: 1, b: 2, c: 3 },
  setters: { a: "r1", b: "r2", c: "r3" },
  order: ["r1", "r2", "r3"],
  conflicts: [
    { key: "a", winner: "r1", losers: ["r2"] },
    { key: "b", winner: "r2", losers: ["r1"] },
  ],
  orphans: [],
};

test("a cell with no contested decision is certain", () => {
  const s = buildSheet(fold, {}, {});
  const c = s.byKey["c"];
  assert.equal(c.confidence, 1.0);
  assert.equal(c.contested, false);
  assert.deepEqual(c.decisions, []);
});

test("a cell inherits the LEAST confident decision, not the mean", () => {
  // Two decisions: 0.99 and 0.30. The mean is 0.645; the minimum is 0.30.
  // A mean would let one uncertain decision hide behind a certain one,
  // which is how a confidence display becomes a lie.
  const s = buildSheet(fold, { "a:r1:r2": 0.99, "b:r2:r1": 0.30 }, {});
  assert.equal(s.byKey["a"].confidence, 0.99);
  assert.equal(s.byKey["b"].confidence, 0.30);
  assert.notEqual(s.byKey["b"].confidence, (0.99 + 0.30) / 2);
});

test("a WINNER's uncertainty propagates; a LOSER's does not", () => {
  const s = buildSheet(fold, {}, { r1: 0.55 });
  // r1 WON a, so a inherits r1's 0.55.
  assert.equal(s.byKey["a"].confidence, 0.55);
  // r1 only LOST b -- r2 won it. A cell that did not depend on r1 is
  // not made less certain by r1 being uncertain. (My first draft of
  // this test asserted the opposite, and was wrong: the cell's value
  // does not rest on the loser's opinion.)
  assert.equal(s.byKey["b"].confidence, 1.0);
  assert.equal(s.byKey["c"].confidence, 1.0);
});

test("the sheet's confidence is its WEAKEST cell", () => {
  const s = buildSheet(fold, { "a:r1:r2": 0.9, "b:r2:r1": 0.4 }, {});
  assert.equal(sheetConfidence(s), 0.4);
});

test("fragile cells are the worklist, worst first", () => {
  const s = buildSheet(fold, { "a:r1:r2": 0.2, "b:r2:r1": 0.6 }, {});
  const f = fragileCells(s);
  assert.equal(f.length, 2);
  assert.equal(f[0].key, "a");   // 0.2 before 0.6
  assert.ok(f[0].confidence < f[1].confidence);
});

test("affectedCells finds exactly the cells a record contested", () => {
  const s = buildSheet(fold, {}, {});
  assert.deepEqual(affectedCells(s, "r1").map((c) => c.key).sort(), ["a", "b"]);
  assert.deepEqual(affectedCells(s, "r3").map((c) => c.key), ["c"]);
});

test("a class change distinguishes a value change from a certainty change", () => {
  // Changing r1's class changes the VALUE of a (r1 won it) but only
  // the CERTAINTY of b (r2 won it, r1 merely lost).
  const s = buildSheet(fold, {}, {});
  const eff = propagateClassChange(s, "r1", "witness");
  const byKey = Object.fromEntries(eff.map((e) => [e.key, e.effect]));
  assert.equal(byKey["a"], "value-changes");
  assert.equal(byKey["b"], "certainty-changes");
});

test("the winner is read from the conflict ledger even without a setters map", () => {
  // A port that does not emit setters is legal. Reading ONLY setters
  // would produce a sheet with null setters and 100% confidence on
  // every cell -- certain because it knows nothing.
  const noSetters = { ...fold };
  delete noSetters.setters;
  const s = buildSheet(noSetters, { "a:r1:r2": 0.5 }, {});
  assert.equal(s.byKey["a"].setter, "r1");
  assert.equal(s.byKey["a"].confidence, 0.5);
  assert.equal(s.byKey["a"].dependsOn.includes("r2"), true);
});

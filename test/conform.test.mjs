import test from "node:test";
import assert from "node:assert/strict";
import { compareFolds, contestedAgreement, deepEqual } from "../src/conform.mjs";

const foldA = {
  state: { x: 1, y: 2 },
  setters: { x: "r1", y: "r2" },
  order: ["r1", "r2"],
  conflicts: [{ key: "x", winner: "r1", losers: ["r3"] }],
  orphans: ["r4"],
};

test("two folds that agree produce no disagreements", () => {
  const c = compareFolds(foldA, structuredClone(foldA));
  assert.equal(c.agree, true);
  assert.equal(c.summary.disagreeing, 0);
  assert.equal(c.orphansAgree, true);
  assert.equal(c.orderAgrees, true);
});

test("a VALUE disagreement is distinguished from a PROVENANCE one", () => {
  // Same value, different setter: the fold decided the same thing by a
  // different route. That points at a different clause than a wrong
  // value does.
  const b = structuredClone(foldA);
  b.setters.x = "r9";
  const c = compareFolds(foldA, b);
  assert.equal(c.agree, false);
  assert.equal(c.summary.valueDisagreements, 0);
  assert.equal(c.summary.setterDisagreements, 1);
  const cell = c.cells.find((x) => x.key === "x");
  assert.equal(cell.kind, "setter");
});

test("a wrong VALUE is reported as a value disagreement", () => {
  const b = structuredClone(foldA);
  b.state.x = 99;
  const c = compareFolds(foldA, b);
  assert.equal(c.summary.valueDisagreements, 1);
  const cell = c.cells.find((x) => x.key === "x");
  assert.equal(cell.kind, "value");
  assert.deepEqual(cell.value, { a: 1, b: 99 });
});

test("a missing key in one fold is a disagreement, not an absence", () => {
  const b = structuredClone(foldA);
  delete b.state.y;
  delete b.setters.y;
  const c = compareFolds(foldA, b);
  const cell = c.cells.find((x) => x.key === "y");
  assert.equal(cell.agree, false);
});

test("orphan and order differences are reported separately from cells", () => {
  const b = structuredClone(foldA);
  b.orphans = ["r4", "r5"];
  b.order = ["r2", "r1"];
  const c = compareFolds(foldA, b);
  assert.equal(c.orphansAgree, false);
  assert.equal(c.orderAgrees, false);
  assert.equal(c.summary.disagreeing, 0, "the cells themselves still agree");
});

test("contested cells are identified, and a wrong winner is flagged", () => {
  const c = contestedAgreement(foldA, foldA);
  assert.equal(c.length, 1);
  assert.equal(c[0].agree, true);
  const b = structuredClone(foldA);
  b.state.x = 99;
  const c2 = contestedAgreement(foldA, b);
  assert.equal(c2[0].agree, false);
  assert.equal(c2[0].kind, "value");
});

test("numeric and structural deep equality", () => {
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), false);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(null, undefined), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
});

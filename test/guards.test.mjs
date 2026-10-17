import test from "node:test";
import assert from "node:assert/strict";
import { needsIsolation, isAggregateClaim, adjudicate, NEAR_THRESHOLD } from "../src/guards.mjs";

test("an item near the gate must be re-asked alone", () => {
  // Measured: batching moved borderline items by up to 0.037, larger
  // than the 0.002-0.005 run-to-run noise. So a score in the band
  // around the gate cannot be trusted from a batched request.
  const s = new Map([["a", 0.99], ["b", 0.5], ["c", 0.11], ["d", 0.4], ["e", 0.7]]);
  const need = needsIsolation(s);
  assert.deepEqual(need.sort(), ["b", "d", "e"]);
});

test("an aggregate claim is never a safe gate", () => {
  // Measured: a counting claim sat at 0.511 +/- 0.044 while a
  // comparable one scored 0.983. Counting lands ambiguously.
  assert.equal(isAggregateClaim("Five of the twelve records set key k0."), true);
  assert.equal(isAggregateClaim("How many records have kind null?"), true);
  assert.equal(isAggregateClaim("Every record sets some key."), true);
  assert.equal(isAggregateClaim("A record of kind override outranks a record of kind witness."), false);
});

test("adjudication refuses to gate an aggregate claim", () => {
  const claims = { c1: { statement: "Five of the twelve records set key k0." } };
  const v = adjudicate(new Map([["c1", 0.95]]), claims);
  assert.equal(v[0].status, "unreliable");
});

test("adjudication marks a near-threshold score for isolation", () => {
  const v = adjudicate(new Map([["c1", 0.52]]), { c1: { statement: "A record of kind override outranks a witness." } });
  assert.equal(v[0].status, "needs-isolation");
});

test("adjudication distinguishes supported from not-supported", () => {
  const v = adjudicate(new Map([["hi", 0.95], ["lo", 0.03]]), {});
  assert.equal(v.find((x) => x.id === "hi").status, "supported");
  assert.equal(v.find((x) => x.id === "lo").status, "not-supported");
});

test("a missing score is not a pass", () => {
  const v = adjudicate(new Map([["x", null]]), {});
  assert.equal(v[0].status, "no-score");
});

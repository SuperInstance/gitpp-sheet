import test from "node:test";
import assert from "node:assert/strict";
import { buildSheet } from "../src/sheet.mjs";
import { regionConfidence, decide, effectsOf } from "../src/triggers.mjs";

const fold = {
  state: { solid: 1, shaky: 2 },
  setters: { solid: "r1", shaky: "r2" },
  order: ["r1", "r2"],
  conflicts: [
    { key: "solid", winner: "r1", losers: ["r3"] },
    { key: "shaky", winner: "r2", losers: ["r3"] },
  ],
  orphans: [],
};

test("region confidence is the WEAKEST cell the action touches", () => {
  const s = buildSheet(fold, { "solid:r1:r3": 0.95, "shaky:r2:r3": 0.25 }, {});
  const r = regionConfidence(s, "r3");
  assert.equal(r.confidence, 0.25);
  assert.deepEqual(r.cells.sort(), ["shaky", "solid"]);
});

test("an action touching a fragile cell needs a HIGHER score, not a lower one", () => {
  const s = buildSheet(fold, { "solid:r1:r3": 0.95, "shaky:r2:r3": 0.25 }, {});
  // r3 touches 'shaky' at 0.25, which is fragile.
  assert.equal(s.byKey["shaky"].fragile, true);
  assert.equal(s.byKey["solid"].fragile, false);

  // At 0.60, the action would clear the plain 0.5 gate -- but it lands
  // on a fragile cell, so the bar is 0.75 and it must NOT be applied.
  const d = decide({ actionScore: 0.60, action: "r3", sheet: s });
  assert.equal(d.apply, false);
  assert.equal(d.touchesFragile, true);
  assert.equal(d.required, 0.75);
});

test("the same action score applies when it touches only certain cells", () => {
  const s = buildSheet(fold, { "solid:r1:r3": 0.95, "shaky:r2:r3": 0.95 }, {});
  const d = decide({ actionScore: 0.60, action: "r3", sheet: s });
  assert.equal(d.apply, true);
  assert.equal(d.required, 0.5);
});

test("the binding constraint is reported", () => {
  const s = buildSheet(fold, { "solid:r1:r3": 0.95, "shaky:r2:r3": 0.25 }, {});
  const weakAction = decide({ actionScore: 0.20, action: "r3", sheet: s });
  assert.equal(weakAction.apply, false);
  assert.equal(weakAction.binding, "the action's own score");
});

test("effects distinguish a value change from a certainty change", () => {
  const s = buildSheet(fold, { "solid:r1:r3": 0.95, "shaky:r2:r3": 0.95 }, {});
  // r3 LOST both cells, so changing r3's class changes only the
  // CERTAINTY of each, never the value.
  const e3 = effectsOf({ action: "r3", sheet: s, records: [] });
  const byKey3 = Object.fromEntries(e3.changes.map((c) => [c.key, c.kind]));
  assert.equal(byKey3["solid"], "certainty-changes");
  assert.equal(byKey3["shaky"], "certainty-changes");

  // r1 WON 'solid' and was not a candidate for 'shaky' at all, so
  // changing r1's class changes the VALUE of 'solid' and leaves
  // 'shaky' untouched.
  const e1 = effectsOf({ action: "r1", sheet: s, records: [] });
  const byKey1 = Object.fromEntries(e1.changes.map((c) => [c.key, c.kind]));
  assert.equal(byKey1["solid"], "value-changes");
  assert.equal(byKey1["shaky"], undefined, "r1 did not contest 'shaky'");
  assert.ok(e1.untouched.includes("shaky"));
});

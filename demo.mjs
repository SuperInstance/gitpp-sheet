// End-to-end: a real fold -> claims -> Jev scores -> a sheet with
// cell-level confidence, and a graph that shows where it came from.
import { derive } from "/tmp/rr2/readers/js/fold.mjs";
import { buildSheet, sheetConfidence, fragileCells, affectedCells, propagateClassChange } from "./src/sheet.mjs";
import { buildClaimSet } from "./src/claims.mjs";
import { renderGraph, renderText } from "./src/graph.mjs";
import { scoreClaims } from "./src/jev.mjs";
import { writeFileSync } from "node:fs";

// A record set that CONTESTS keys, so the fold has decisions to be
// uncertain about. Two same-key records of different classes, plus a
// tie-break case, plus a cycle and a missing parent.
const records = [
  { id: "req-1",   kind: "task",     parents: [],          effects: { "config.timeout": 30, "status": "open" } },
  { id: "req-2",   kind: "override", parents: ["req-1"],  effects: { "config.timeout": 45 } },
  { id: "obs-1",   kind: "witness",  parents: ["req-1"],  effects: { "config.timeout": 60, "env.load": 17 } },
  { id: "obs-2",   kind: "witness",  parents: ["req-2"],  effects: { "env.load": 12 } },
  { id: "ghost",   kind: "task",     parents: ["gone"],   effects: { "never": 1 } },
  { id: "cyc-a",   kind: "task",     parents: ["cyc-b"],  effects: { "cyc": 1 } },
  { id: "cyc-b",   kind: "task",     parents: ["cyc-a"],  effects: { "cyc": 2 } },
  { id: "twin",    kind: "task",     parents: ["req-1"],  effects: { "same": 1 } },
  { id: "twin2",   kind: "task",     parents: ["req-1"],  effects: { "same": 2 } },
];

const fold = derive(records);
console.log("  fold:");
console.log(`    state     ${JSON.stringify(fold.state)}`);
console.log(`    order     ${JSON.stringify(fold.order)}`);
console.log(`    orphans   ${JSON.stringify(fold.orphans)}`);
console.log(`    conflicts ${JSON.stringify(fold.conflicts)}`);
console.log();

const { claims } = buildClaimSet(records, fold);
console.log(`  ${claims.length} claims extracted from the fold:`);
for (const c of claims.slice(0, 6)) console.log(`    ${c.id}\n      ${c.statement}`);
console.log();

// Score them against the spec, if a token is available.
let scores = new Map();
if (process.env.TYPESAFE_AI_TOKEN) {
  const spec = (await import("node:fs")).readFileSync("/tmp/v046d/SPEC.md", "utf8");
  console.log("  scoring claims against the spec via Jev ...");
  const t0 = Date.now();
  scores = await scoreClaims(claims, spec);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const [id, s] of scores) console.log(`    ${id}  ${s?.toFixed(3)}`);
} else {
  console.log("  (no TYPESAFE_AI_TOKEN -- using synthetic scores to show the shape)");
  const seed = 42;
  let i = 0;
  for (const c of claims) {
    i = (i * 1103515245 + seed) % 2147483647;
    scores.set(c.id, 0.5 + ((i % 1000) / 1000) * 0.5);
  }
}
console.log();

const sheet = buildSheet(fold, Object.fromEntries(scores), {});
console.log("  THE SHEET");
console.log(renderText(sheet, records));
console.log();
console.log(`  sheet confidence (weakest cell): ${(sheetConfidence(sheet) * 100).toFixed(0)}%`);
console.log(`  fragile cells: ${fragileCells(sheet).map((c) => c.key).join(", ") || "none"}`);
console.log();
console.log("  EFFECT OF CHANGING req-2's class:");
for (const e of propagateClassChange(sheet, "req-2", "witness")) {
  console.log(`    ${e.key.padEnd(20)} ${e.effect.padEnd(20)} conf ${(e.currentConfidence * 100).toFixed(0)}%`);
}
writeFileSync("/tmp/sheet/graph.svg", renderGraph(sheet, records));
console.log("\n  wrote /tmp/sheet/graph.svg");

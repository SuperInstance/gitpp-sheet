// The full pipeline, live, against this project's real SPEC.md.
//
//   fold  ->  claims  ->  Jev  ->  sheet (per-cell confidence)
//         ->  triggers (what an action would do, and whether to do it)
//
// The point of the last step: the gate asks "should we apply this
// action?" and the sheet asks "what does it touch, and how sure are we
// of that?". Neither alone is enough.
import { derive } from process.env.GITPP_JS_SRC || "/tmp/rr2/readers/js/fold.mjs";
import { buildSheet, sheetConfidence, fragileCells } from "./src/sheet.mjs";
import { buildClaimSet } from "./src/claims.mjs";
import { scoreClaimsGuarded } from "./src/jev.mjs";
import { decide, regionConfidence, effectsOf } from "./src/triggers.mjs";
import { renderText, renderGraph } from "./src/graph.mjs";
import { readFileSync, writeFileSync } from "node:fs";

// A record set that CONTESTS keys in two different ways: one by class
// (an override beating a task) and one by tie-break (two tasks), plus a
// missing parent and a cycle.
const records = [
  { id: "req-1",   kind: "task",     parents: [],          effects: { "config.timeout": 30, "status": "open" } },
  { id: "req-2",   kind: "override", parents: ["req-1"],  effects: { "config.timeout": 45 } },
  { id: "obs-1",   kind: "witness",  parents: ["req-1"],  effects: { "config.timeout": 60, "env.load": 17 } },
  { id: "twin-a",  kind: "task",     parents: ["req-1"],  effects: { "cache.ttl": 5 } },
  { id: "twin-b",  kind: "task",     parents: ["req-1"],  effects: { "cache.ttl": 9 } },
  { id: "unknown", kind: "weird",    parents: ["req-1"],  effects: { "cache.ttl": 1 } },
  { id: "lost",    kind: "task",     parents: ["gone"],   effects: { "never": 1 } },
];

const fold = derive(records);
const { claims } = buildClaimSet(records, fold);
const spec = readFileSync(process.env.GITPP_SPEC || "/tmp/v046d/SPEC.md", "utf8");

console.log("  FOLD");
console.log(`    state     ${JSON.stringify(fold.state)}`);
console.log(`    conflicts ${JSON.stringify(fold.conflicts)}`);
console.log(`    orphans   ${JSON.stringify(fold.orphans)}`);
console.log();

console.log(`  ${claims.length} claims -> Jev (guarded)`);
const g = await scoreClaimsGuarded(claims, { spec }, {});
if (g.blocked) {
  console.log(`    BLOCKED: ${g.reason}`);
  process.exit(1);
}
console.log(`    contradiction score ${g.contradiction.score.toFixed(3)} (floor 0.7)`);
for (const v of g.verdicts) {
  console.log(`    ${v.id.padEnd(32)} ${v.score?.toFixed(3)}  ${v.status}`);
}
console.log();

const sheet = buildSheet(fold, Object.fromEntries(g.scores), {});
console.log("  SHEET");
console.log(renderText(sheet, records));
console.log();
console.log(`  sheet confidence (weakest cell): ${(sheetConfidence(sheet) * 100).toFixed(0)}%`);
const frag = fragileCells(sheet);
console.log(`  fragile: ${frag.map((c) => `${c.key}@${(c.confidence * 100).toFixed(0)}%`).join(", ") || "none"}`);
console.log();

console.log("  TRIGGERS");
for (const id of ["req-2", "unknown", "twin-b"]) {
  const r = regionConfidence(sheet, id);
  console.log(`    ${id.padEnd(9)} touches ${JSON.stringify(r.cells)} at ${(r.confidence * 100).toFixed(0)}%`);
  for (const score of [0.55, 0.80, 0.95]) {
    const d = decide({ actionScore: score, action: id, sheet });
    console.log(`        action@${score.toFixed(2)} -> apply=${String(d.apply).padEnd(5)} required=${d.required.toFixed(2)}  binding=${d.binding}`);
  }
}
console.log();
const eff = effectsOf({ action: "req-2", sheet, records });
console.log(`  EFFECTS of changing req-2: ${eff.summary}`);
for (const c of eff.changes) console.log(`    ${c.key.padEnd(16)} ${c.kind.padEnd(20)} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
writeFileSync("/tmp/sheet/live-graph.svg", renderGraph(sheet, records));
console.log("\n  wrote /tmp/sheet/live-graph.svg");

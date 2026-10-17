// Triggers and effects: turning a sheet into something an agent can act
// on.
//
// `gitpp-gate` already uses Jev to ROUTE: a proposed action is applied
// only if the judge clears a threshold, and absent signal fails closed.
// That is the trigger half. What it cannot see is the EFFECT half: the
// gate asks "should we apply this action?", and a nudge that touches a
// certain cell is not the same proposition as a nudge that touches an
// uncertain one.
//
//    gate  : "should we apply this action?"  -> a score on a CLAIM
//    sheet : "what does this action affect?"  -> a score per CELL
//
// So the same action can be safe to apply and pointless, or safe to
// skip and decisive, and the gate alone cannot tell which.
//
// This module joins the two: given a proposed action and a sheet, it
// reports the affected cells, the confidence of the affected region,
// and whether the action's own confidence is adequate for the cells it
// would touch.

import { affectedCells, propagateClassChange } from "./sheet.mjs";
import { GATE } from "./guards.mjs";

/**
 * The confidence of the REGION an action touches.
 *
 * This is the minimum over the affected cells, and it is the number
 * the gate is missing. An action whose own claim scores 0.95 but which
 * lands on a cell whose confidence is 0.30 is a different proposition
 * from one that scores 0.95 and lands on a cell at 0.97.
 */
export function regionConfidence(sheet, recordId) {
  const cells = affectedCells(sheet, recordId);
  if (!cells.length) return { confidence: 1.0, cells: [], reason: "the action touches no contested cell" };
  const confidence = Math.min(...cells.map((c) => c.confidence));
  return {
    confidence,
    cells: cells.map((c) => c.key),
    weakest: cells.slice().sort((a, b) => a.confidence - b.confidence)[0],
    reason: "the weakest cell the action would touch",
  };
}

/**
 * Should this action be applied?
 *
 * Combines the gate's own score on the ACTION with the sheet's
 * confidence in the CELLS the action touches, and says which of the
 * two is the binding constraint.
 *
 * The policy is deliberately conservative in one specific way: an
 * action that touches a FRAGILE cell needs a HIGHER score on itself,
 * not a lower one. Applying an action to a cell you are unsure about
 * is exactly when you want the action to be well-justified.
 */
export function decide({ actionScore, action, sheet, threshold = GATE, fragileThreshold = 0.75 }) {
  const region = regionConfidence(sheet, action);
  const touchesFragile = region.cells.some((k) => sheet.byKey[k]?.fragile);

  // The bar for the action rises when it lands on an uncertain cell.
  const required = touchesFragile ? Math.max(threshold, fragileThreshold) : threshold;

  const apply = actionScore >= required;
  const binding = apply
    ? (region.confidence < threshold ? "the cell confidence" : "the action's own score")
    : (actionScore < required ? "the action's own score" : "the cell confidence");

  return {
    apply,
    actionScore,
    required,
    region,
    touchesFragile,
    binding,
    why:
      `action score ${actionScore?.toFixed(2)} against a required ${required.toFixed(2)}; ` +
      `the cells it touches are at ${region.confidence.toFixed(2)}` +
      (touchesFragile ? ", and one of them is fragile, so the bar is raised" : "") +
      `. The binding constraint is ${binding}.`,
  };
}

/**
 * The full effect of an action, for a downstream consumer.
 *
 * This is the 'effects' half of 'triggers and effects': what changes,
 * what merely becomes less certain, and what is untouched.
 */
export function effectsOf({ action, sheet, records }) {
  const changes = propagateClassChange(sheet, action, "other");
  const touched = new Set(changes.map((c) => c.key));
  return {
    changes: changes.map((c) => ({
      key: c.key,
      kind: c.effect,                 // value-changes | certainty-changes
      from: c.currentValue,
      to: c.currentSetter,
      confidence: c.currentConfidence,
    })),
    untouched: sheet.cells.filter((c) => !touched.has(c.key)).map((c) => c.key),
    summary:
      `${changes.filter((c) => c.effect === "value-changes").length} cell(s) change value, ` +
      `${changes.filter((c) => c.effect === "certainty-changes").length} change certainty only, ` +
      `${sheet.cells.length - touched.size} untouched.`,
  };
}

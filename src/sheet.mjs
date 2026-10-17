// A fold as a spreadsheet: cells with values, provenance, and confidence.
//
// The fold gives state (key->value), setters (key->record), order, and
// conflicts. This adds a THIRD axis: how confident we are that each
// cell holds the value it holds.
//
// The key idea is that a cell's confidence is not the confidence of the
// record that set it. The value of a cell depends on a DECISION --
// "record A beat record B for this key" -- and that decision depends on
// claims about class and ancestry. So confidence is attached to the
// decision, and propagated to the cells the decision decided.
//
// A cell that no uncertain decision touched is CERTAIN, even if every
// record involved was scored 0.7. That distinction is the whole point:
// an average of record scores is not a confidence.

/**
 * Build a sheet from a fold result plus per-decision confidences.
 *
 * @param fold   {state, setters, order, conflicts}
 * @param claims { "<key>:<winner>:<loser>": 0..1 }   confidence that the
 *                winner beat the loser for that key
 * @param priors { "<recordId>": 0..1 }               confidence in each
 *                record's own properties (class, parentage)
 */
export function buildSheet(fold, claims = {}, priors = {}) {
  const { state = {}, setters = {}, conflicts = [] } = fold;
  const cells = [];

  for (const [key, value] of Object.entries(state)) {
    const conflict = conflicts.find((c) => c.key === key) ?? null;
    // The conflict ledger names the winner for CONTESTED keys, and the
    // setters map names it for all of them. Prefer the conflict (it is
    // always present when the key was contested) and fall back to
    // setters for uncontested keys.
    //
    // Reading ONLY setters is a trap: a port that does not emit setters
    // -- which is legal, the field is optional in some readers -- would
    // silently produce a sheet where every cell has a null setter, no
    // decisions, and therefore 100% confidence on every cell. A sheet
    // that is certain because it knows nothing is worse than no sheet.
    const winner = conflict?.winner ?? setters[key] ?? null;
    const losers = conflict?.losers ?? [];

    // The decisions that produced this cell:
    //   - the winner-beats-each-loser comparison, for every loser
    //   - the winner's own class and parentage, if uncertain
    const decisions = [];
    for (const loser of losers) {
      const c = claims[`${key}:${winner}:${loser}`];
      decisions.push({
        kind: "class-precedence",
        subject: `${winner} > ${loser}`,
        confidence: c ?? 1.0,        // absent claim => unchallenged
        detail: `for key "${key}"`,
      });
    }
    if (winner !== null) {
      const p = priors[winner];
      if (p !== undefined) {
        decisions.push({
          kind: "record-properties",
          subject: winner,
          confidence: p,
          detail: `class and parentage of "${winner}"`,
        });
      }
    }
    // NOTE: a LOSER's own uncertainty does NOT propagate to the cell.
    // If the winner is uncertain, the cell is uncertain. If a loser is
    // uncertain, the cell is not -- the loser did not determine the
    // value, and a cell that did not depend on it is not made less
    // certain by it. (An earlier version of this code propagated the
    // loser's prior too, which made a cell uncertain because of a record
    // whose opinion did not matter. The test for it caught that.)

    // Confidence of the cell = the LEAST confident decision that
    // produced it. A chain of independent 0.9s is still 0.9, not 0.81,
    // because no single decision is in doubt -- but a single 0.4
    // decision makes the whole cell uncertain, because that decision is
    // exactly what the cell rests on.
    //
    // This is deliberately a MINIMUM and not a product or a mean:
    //   - a mean hides a single uncertain decision behind many certain
    //     ones, which is how a confidence display becomes a lie
    //   - a product compounds independent decisions and understates
    //     certainty for a decision that is certain
    // The minimum is the honest summary of "what is the weakest link
    // in the argument for this cell".
    const confidence = decisions.length
      ? Math.min(...decisions.map((d) => d.confidence))
      : 1.0;

    // Which records, if any, would change this cell? The losers, plus
    // the winner itself. This is the dependency list, and it is what
    // makes "what does this action affect?" answerable.
    const dependsOn = [winner, ...losers].filter((x) => x !== null);

    cells.push({
      key,
      value,
      setter: winner,
      confidence,
      decisions,
      dependsOn,
      contested: losers.length > 0,
      // A cell is "fragile" if its confidence is below the threshold.
      // Fragile is the queryable form of the score.
      fragile: confidence < 0.75,
    });
  }

  cells.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    cells,
    // Cell index by key, for the dependency queries.
    byKey: Object.fromEntries(cells.map((c) => [c.key, c])),
  };
}

/**
 * Which cells would change if this record's class were different?
 *
 * This is the question a spreadsheet abstraction answers natively and a
 * graph picture does not: a cell depends on the records that contested
 * it, so a change to a record's class propagates to exactly the cells
 * that record contested.
 */
export function affectedCells(sheet, recordId) {
  return sheet.cells.filter((c) => c.dependsOn.includes(recordId));
}

/**
 * Propagate a class change: which cells change value, and which merely
 * become uncertain.
 *
 * A record that LOSES a contest does not change the cell's value -- it
 * changes the cell's CONFIDENCE, because the contest is no longer
 * decided. A record that WINS changes the value. Both are effects, and
 * they are different effects, which is why "triggers and effects
 * downstream" needs a structure that can tell them apart.
 */
export function propagateClassChange(sheet, recordId, newClass) {
  const effects = [];
  for (const c of sheet.cells) {
    if (!c.dependsOn.includes(recordId)) continue;
    const decision = c.decisions.find(
      (d) => d.kind === "class-precedence" && d.subject.startsWith(recordId),
    );
    effects.push({
      key: c.key,
      effect: decision ? "value-changes" : "certainty-changes",
      currentValue: c.value,
      currentSetter: c.setter,
      currentConfidence: c.confidence,
      contested: c.contested,
    });
  }
  return effects;
}

/**
 * The overall confidence of the sheet: the weakest cell.
 *
 * A sheet is as trustworthy as its least-trusted cell, because a
 * consumer reading the sheet reads ALL of it. A mean would let 99
 * certain cells hide one uncertain one.
 */
export function sheetConfidence(sheet) {
  if (!sheet.cells.length) return 1.0;
  return Math.min(...sheet.cells.map((c) => c.confidence));
}

/**
 * The fragile cells, worst first. This is the worklist: what a reviewer
 * should look at.
 */
export function fragileCells(sheet) {
  return sheet.cells
    .filter((c) => c.fragile)
    .sort((a, b) => a.confidence - b.confidence);
}

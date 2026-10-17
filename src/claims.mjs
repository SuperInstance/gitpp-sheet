// Turn a fold into the CLAIMS that decide it, so a judge can be asked
// about the right things.
//
// This is the piece that makes a judge's output usable. A judge asked
// "is this record a task?" gives a per-record score, which is a
// property of the RECORD. The fold does not depend on record
// properties; it depends on RELATIONS between them.
//
//   "r0003 is a task"              <- a property of r0003
//   "r0003 (a task) outranks r0007 (a witness) for key k0"  <- the
//                                      decision the cell actually
//                                      rests on
//
// The second is what a cell's confidence must be derived from, and it
// is also the only one of the two that a text-grounded judge can
// answer at all, because it is a claim about the SPEC and the two
// records.
//
// So: extract the claims, ask the judge about the claims, propagate the
// answers back onto the cells.

/**
 * Extract the class-precedence claims a fold's conflicts imply.
 *
 * For each key with a conflict, and each loser, the claim is:
 *   "<winner> outranks <loser> for key <key>"
 * which, given the two records' kinds, is a statement about the SPEC's
 * class-precedence rule.
 */
export function extractClaims(records, fold) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const claims = [];
  for (const c of fold.conflicts ?? []) {
    const winner = byId.get(c.winner);
    for (const loser of c.losers ?? []) {
      const l = byId.get(loser);
      // SAME-CLASS contestants are a DIFFERENT decision, and claiming
      // otherwise is a bug in the claim set rather than in the spec.
      //
      // The first version of this file emitted one claim shape for every
      // contest: "a record of kind X outranks a record of kind Y". For a
      // same-class contest that reads "a witness outranks a witness" --
      // and the spec says nothing about that, because same-class
      // contests are decided by 5.4's tie-break (ancestry, then topo
      // order), NOT by class precedence.
      //
      // The judge caught it: those claims scored 0.15 and 0.11 while
      // genuine class-precedence claims scored 0.99. The instrument
      // found a hole in the CLAIM SET, and the two fragile cells it
      // flagged were exactly the two decided by the uncovered rule.
      const sameClass = (winner?.kind ?? null) === (l?.kind ?? null);
      claims.push({
        id: `${c.key}:${c.winner}:${loser}`,
        key: c.key,
        winner: c.winner,
        loser,
        winnerKind: winner?.kind ?? null,
        loserKind: l?.kind ?? null,
        decision: sameClass ? "tie-break" : "class-precedence",
        statement: sameClass
          ? `In the git.pp specification, when two records of the same class ` +
            `contest the same key, the one that is a DESCENDANT of the other ` +
            `wins; and if neither descends from the other, the one that comes ` +
            `first in topological order wins.`
          : `In the git.pp specification, a record of kind "${winner?.kind}" ` +
            `outranks a record of kind "${l?.kind}" for the same key.`,
        clause: sameClass
          ? "SPEC 5.2 step 3: if the classes are equal, a descendant wins; " +
            "and 5.4: ties are broken by smallest-id-first"
          : "SPEC 5.1: class precedence is absolute -- override > task > witness",
      });
    }
  }
  return claims;
}

/**
 * Extract the record-property claims: the class of a record, and the
 * parentage that makes it an orphan or not.
 */
export function extractPropertyClaims(records, fold) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const orphans = new Set(fold.orphans ?? []);
  const claims = [];
  for (const r of records) {
    claims.push({
      id: `prop:${r.id}:kind`,
      record: r.id,
      kind: "class",
      statement:
        `In the git.pp specification, a record whose kind is "${r.kind}" ` +
        (r.kind === null || r.kind === undefined
          ? `has no class and ranks lowest, below witness.`
          : `is a member of the ${r.kind} class.`),
      clause: "SPEC 5.1: class precedence is absolute; an unclassifiable record ranks lowest",
    });
    if (orphans.has(r.id)) {
      claims.push({
        id: `prop:${r.id}:orphan`,
        record: r.id,
        kind: "orphan",
        statement:
          `In the git.pp specification, a record whose own parent id is absent ` +
          `from the record set is an orphan and is excluded from the fold.`,
        clause: "SPEC 5.5: a record is an orphan if any of its parents is not in the applied set",
      });
    }
  }
  return claims;
}

/**
 * The claim set a judge should be asked about, in a form that suits a
 * single request: grouped by clause, so a judge that carries state
 * across questions in one request sees a coherent context.
 */
export function buildClaimSet(records, fold) {
  const claims = [...extractClaims(records, fold), ...extractPropertyClaims(records, fold)];
  const byClause = new Map();
  for (const c of claims) {
    if (!byClause.has(c.clause)) byClause.set(c.clause, []);
    byClause.get(c.clause).push(c);
  }
  return { claims, byClause };
}

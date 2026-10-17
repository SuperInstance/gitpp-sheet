// Cell-level conformance between ports.
//
// Record-level conformance compares LEAVES: one record in, one hash
// out. That is a strong check on ENCODING and says nothing about the
// FOLD, because the fold is a property of a RECORD SET.
//
// Cell-level conformance compares the FOLD: for one record set, do two
// ports agree on which VALUE each key holds, which record set it, and
// which records lost? That is the claim the whole project rests on --
// "the fold semantics are pinned" -- and until now it was only ever
// checked by the ports agreeing on a hash of a single record.
//
// The difference matters. A port can produce the right leaves and
// still fold wrongly, and a leaf corpus can never see it: the leaf of a
// record does not depend on any other record.
//
// So: run two ports over one record set, and compare the SHEET, not the
// hash.

export function compareFolds(a, b) {
  const keys = [...new Set([...Object.keys(a.state || {}), ...Object.keys(b.state || {})])].sort();
  const cells = [];
  for (const key of keys) {
    const av = (a.state || {})[key];
    const bv = (b.state || {})[key];
    const as = (a.setters || {})[key];
    const bs = (b.setters || {})[key];
    const sameValue = deepEqual(av, bv);
    const sameSetter = as === bs;
    cells.push({
      key, agree: sameValue && sameSetter,
      value: { a: av, b: bv }, setter: { a: as, b: bs },
      kind: !sameValue ? "value" : !sameSetter ? "setter" : null,
    });
  }
  const ao = (a.orphans || []).slice().sort();
  const bo = (b.orphans || []).slice().sort();
  const ords = (a.order || []).join(",") === (b.order || []).join(",");
  return {
    cells,
    agree: cells.every((c) => c.agree),
    orphansAgree: deepEqual(ao, bo),
    orderAgrees: ords,
    // A summary that says WHERE they differ, because "the ports
    // disagree" is not a finding and "they disagree on 3 of 12 cells,
    // all contested" is.
    summary: {
      cells: cells.length,
      disagreeing: cells.filter((c) => !c.agree).length,
      valueDisagreements: cells.filter((c) => c.kind === "value").length,
      setterDisagreements: cells.filter((c) => c.kind === "setter").length,
      orphansAgree: deepEqual(ao, bo),
      orderAgrees: ords,
    },
  };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) || a === b;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Which cells are CONTESTED -- where two records competed -- and does the
 * pair of ports agree there?
 *
 * This is the sharp end. An uncontested cell is decided by one record
 * and every correct port gets it right. A contested cell is decided by
 * a RULE, and a rule is exactly what two ports can read differently.
 */
export function contestedAgreement(foldA, foldB) {
  const byKey = new Map();
  for (const c of foldA.conflicts ?? []) {
    byKey.set(c.key, { contested: true, winner: c.winner, losers: c.losers });
  }
  const out = [];
  for (const [key, info] of byKey) {
    const a = (foldA.state || {})[key];
    const b = (foldB.state || {})[key];
    const aw = (foldA.setters || {})[key];
    const bw = (foldB.setters || {})[key];
    out.push({
      key, winnerA: aw, winnerB: bw,
      agree: deepEqual(a, b) && aw === bw,
      // A cell where the WINNERS differ but the VALUES agree is a
      // different failure from one where the values differ, and it
      // points at a different clause: the value is right, the
      // provenance is wrong.
      kind: deepEqual(a, b) ? (aw === bw ? null : "provenance") : "value",
    });
  }
  return out;
}

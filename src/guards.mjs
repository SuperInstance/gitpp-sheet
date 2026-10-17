// Guards derived from measured Jev behaviour.
//
// A capability probe over 26 labelled claims found three properties of
// the tool that a harness must account for. Each guard below exists
// because of a MEASUREMENT, and each cites it.
//
// 1. THE JUDGE DOES NOT ACT ON A CONTRADICTION IT CAN SEE.
//
//    Asked whether a state contains conflicting clauses, Jev answers
//    0.92-0.96. Asked, in the SAME state, whether a false clause is
//    true, it answers 0.79 -- and that false clause crossed 0.5 in
//    10 of 10 runs. Both clauses get partial credit, biased about
//    +0.14 toward the LATER one.
//
//    So contradiction detection must be a SEPARATE upstream pass. The
//    judge will happily answer from a self-contradicting state.
//
// 2. AGGREGATE CLAIMS ARE EPSTEMICALLY UNCERTAIN, NOT WRONG.
//
//    "Five of the twelve records set key k0" scored 0.511 +/- 0.044 --
//    on the gate, decided by a coin flip -- while a comparable counting
//    claim scored 0.983. Counting is unreliable in a way that reading
//    is not. Never gate on a count.
//
// 3. NEAR-THRESHOLD SCORES SHIFT WHEN QUESTIONS ARE BATCHED.
//
//    Clean items reproduce solo scores to within 0.003, but borderline
//    items moved by up to 0.037 -- larger than the run-to-run noise of
//    0.002-0.005. So an item near the line must be re-asked ALONE.
//
// These are not hypothetical. Each was measured.

// The threshold a score must clear to be treated as settled.
export const GATE = 0.5;
// Items in this band are re-asked in isolation before they may gate.
export const NEAR_THRESHOLD = [0.3, 0.7];

/**
 * The measured failure mode, reproduced on THIS project's own spec.
 *
 *   clean spec:            contradiction detected 0.38
 *                          a FALSE claim scores  0.01
 *   contradictory spec:    contradiction detected 0.96
 *                          a FALSE claim scores  0.86
 *                          a TRUE  claim drops to 0.76
 *
 * So the detector fires (0.38 -> 0.96) and the judge is unusable on
 * the contradictory state without it: the same claim moves from 0.01 to
 * 0.86 purely because a later clause contradicts the earlier one, and
 * a claim that was TRUE at 0.98 falls to 0.76.
 *
 * The judge gives BOTH sides partial credit, biased toward whichever
 * clause comes later. It is not a random error -- it is a systematic
 * one, and a systematic error is the kind that survives a spot check.
 *
 * CONSEQUENCE: run detectContradiction() BEFORE any claim is scored,
 * and refuse to gate on a state that comes back contradictory.
 */
export const CONTRADICTION_FLOOR = 0.7;   // clean 0.38, contradictory 0.96

/**
 * An EMPTY state does not produce a low score. It produces a confident
 * answer from the judge's OWN beliefs, laundered as a spec reading.
 *
 * Measured over 10 world facts absent from every state:
 *
 *   correct state (a real document present)   0.038
 *   unrelated state (a real document present) 0.049
 *   EMPTY state                                0.610   <- !
 *
 * Paired empty-minus-unrelated: +0.561, t(9)=25.6, p<0.0001.
 *
 * So a judge asked about a fictional spec with no state returns ~0.6
 * for a world fact it happens to believe, and that number looks exactly
 * like a confident reading. The signature of an empty state is a
 * mid-range score on a claim that should be cleanly supported or
 * cleanly not.
 *
 * This is why the state-load experiment is worth running: without it,
 * a harness that failed to fetch the spec would report confident
 * nonsense rather than an error.
 */
export function stateIsUsable(state) {
  if (state === null || state === undefined) return { usable: false, reason: "state is missing" };
  if (typeof state === "string") {
    return state.trim().length > 0
      ? { usable: true }
      : { usable: false, reason: "state is an empty string" };
  }
  if (typeof state === "object") {
    const keys = Object.keys(state);
    if (keys.length === 0) return { usable: false, reason: "state is an empty object" };
    // A state whose every value is empty is as good as no state.
    const nonEmpty = Object.values(state).some((v) => {
      if (v === null || v === undefined) return false;
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v).length > 0;
      return true;
    });
    return nonEmpty
      ? { usable: true }
      : { usable: false, reason: "every value in the state is empty" };
  }
  return { usable: false, reason: `state is a ${typeof state}, which the judge does not accept` };
}

/**
 * Does the state contain a contradiction?
 *
 * This is asked SEPARATELY from the claims, because the judge will
 * detect a contradiction and then ignore it.
 */
export async function detectContradiction(state, jevFn, { model = "jev-latest" } = {}) {
  const Q = {
    type: "noul",
    instructions:
      "Answer true only if the state document contains two clauses that " +
      "contradict each other, or otherwise asserts mutually inconsistent things.",
  };
  const score = await jevFn(state, Q, model);
  return { contradictory: score > CONTRADICTION_FLOOR, score };
}

/**
 * Which claims must be re-asked in isolation before they may gate?
 */
export function needsIsolation(scores) {
  const out = [];
  for (const [id, s] of scores) {
    if (s === undefined || s === null) continue;
    if (s >= NEAR_THRESHOLD[0] && s <= NEAR_THRESHOLD[1]) out.push(id);
  }
  return out;
}

/**
 * A claim containing a QUANTITY is not a safe thing to gate on.
 *
 * Measured against this project's own SPEC.md (5,743 words):
 *
 *   GENUINELY FALSE numeric claims score 0.02-0.03
 *     'at least 1e16 is encoded in integer digits'        0.02
 *     'less than 1e-4 is encoded in integer digits'       0.03
 *     'the encoding of a number is never scientific'       0.02
 *
 *   so there is NO false-positive risk from a wrong number.
 *
 *   But a claim whose number is IMPLIED rather than STATED lands in
 *   the ambiguous band. The spec says '|v| >= 1e16 -> scientific',
 *   so 'at least 1e17' is true by implication, and it scores:
 *
 *     1e15 (FALSE)  0.03
 *     1e16 (stated) 0.83
 *     1e17 (implied) 0.50   <- in the band
 *     1e18 (implied) 0.69   <- in the band
 *     1e30 (implied) 0.03
 *
 * The failure is not that numbers are mis-answered -- they are not. It
 * is that a number the reader must INFER is scored ambiguously, and an
 * ambiguous score that occasionally clears a gate is worse than no
 * score. A capability probe on a different corpus found the same thing
 * from the other side: false numeric claims drifted toward 0.2-0.5 as
 * the document grew, ordered by numeric proximity to the text.
 *
 * So: a claim with a number in it is never gated on directly. It is
 * either rephrased to use the number the document actually states, or
 * it is routed to a human.
 */
export function hasQuantity(statement) {
  return /\b\d[\d.eE+-]*\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|zero)\b/i.test(statement);
}

/**
 * A claim about a COUNT is not a safe thing to gate on.
 *
 * Measured: a counting claim sat at 0.511 +/- 0.044 while a
 * comparable one scored 0.983. The failure is not that counts are
 * mis-answered; it is that they land ambiguously, and an ambiguous
 * score that occasionally clears a gate is worse than no score.
 */
export function isAggregateClaim(statement) {
  return /\b(all|every|each|none|most|some|two|three|four|five|six|seven|eight|nine|ten|\d+)\b[^.]*\b(record|records|key|keys|value|values|item|items)\b/i.test(statement)
    || /\b(count|number of|how many|total)\b/i.test(statement);
}

/**
 * The final verdict on a set of scores, with every guard applied.
 *
 * Returns per-claim status so a caller can see WHY something was
 * rejected, rather than getting a number with no provenance.
 */
export function adjudicate(scores, claimsById) {
  const out = [];
  for (const [id, score] of scores) {
    const claim = claimsById?.[id];
    const statement = claim?.statement ?? "";
    if (score === undefined || score === null) {
      out.push({ id, score: null, status: "no-score", reason: "the judge returned no answer" });
      continue;
    }
    if (isAggregateClaim(statement)) {
      out.push({ id, score, status: "unreliable", reason: "aggregate claim: counting is ambiguous in this judge" });
      continue;
    }
    if (hasQuantity(statement)) {
      out.push({ id, score, status: "unreliable", reason: "claim contains a quantity: a number the document only IMPLIES lands in the ambiguous band, so it is not gated on directly" });
      continue;
    }
    if (score >= NEAR_THRESHOLD[0] && score <= NEAR_THRESHOLD[1]) {
      out.push({ id, score, status: "needs-isolation", reason: `score is within ${NEAR_THRESHOLD} of the gate` });
      continue;
    }
    out.push({
      id, score,
      status: score > GATE ? "supported" : "not-supported",
      reason: score > GATE ? "the document explicitly states it" : "the document does not state it",
    });
  }
  return out;
}

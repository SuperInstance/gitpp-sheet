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

// Answering a question NOBODY ASKED, from what is already known.
//
// This is the capability the question graph exists for. A chain of
// thought is asked a set of questions; the answers are recorded; and
// then a DIFFERENT question -- one nobody thought to ask -- is answered
// by recombining the recorded answers.
//
// Two properties make that legitimate rather than clever:
//
//   1. The recomputation is EXACT. The derived answer is computed by
//      the same code path that produced the original verdict, from the
//      same observations. If a question's score changes, the derived
//      answer changes with it, because it reads the ledger and not a
//      copy.
//
//   2. It FAILS CLOSED. If any required question has no observation,
//      the derivation REFUSES and names what is missing. It does not
//      guess, it does not fall back to a default, and it does not
//      quietly treat "no observation" as "no problem".
//
// The receipt is the interesting part. A derived answer says:
//
//   confidence 0.94, resting on 2 CERTIFIED questions and 1 ASSERTED
//   edge, all read against 1 document
//
// The "1 document" is the correlation caveat: two certified questions
// read against the same document are two readings of one document, not
// two independent witnesses. And the "1 ASSERTED edge" is the honesty
// about the limit of the method -- the judge certifies the PREMISES;
// it cannot certify the INFERENCE from one to the next, because it
// reads text and does not do logic.

import { observationOf, distinctStates } from "./ledger.mjs";
import { isolationOrder } from "./qgraph.mjs";
import { NEAR_THRESHOLD } from "./guards.mjs";

/**
 * The verdict a decision gets from a ledger, with no judge call.
 *
 * Returns the same shape the adjudication path produces, so the two
 * can be compared directly -- which is what the closure test does.
 */
export function verdictFromLedger(ledger, questionIds, threshold = 0.5, opts = {}) {
  const { sourceThresholds = null } = opts;
  const missing = [];
  const observed = [];
  for (const id of questionIds) {
    const o = observationOf(ledger, id);
    if (!o) missing.push(id);
    else observed.push(o);
  }
  if (missing.length) {
    return {
      answerable: false,
      missing,
      reason: `no observation for ${missing.join(", ")}. A derived answer may ` +
              `only use what was observed; a missing observation is not a ` +
              `weak observation, it is an absent one.`,
    };
  }

  // The guards travel with the observation, not with the question, so
  // they are re-applied here rather than assumed to have been applied.
  const unreliable = observed.filter(
    (o) => o.verdict === "unreliable" || o.verdict === "contradicted",
  );
  if (unreliable.length) {
    return {
      answerable: false,
      missing: [],
      reason: `the evidence is not safe to gate on: ${unreliable.map((o) =>
        `${o.q} (${o.verdict}: ${o.reason ?? "no reason recorded"})`).join("; ")}`,
    };
  }

  // Near-threshold items must be re-asked ALONE before they may gate.
  // The observation records whether it was asked alone, and the 0.037
  // batch shift is larger than the run-to-run noise, so a batched
  // borderline score cannot settle anything.
  const nearThreshold = observed.filter(
    (o) => o.score >= NEAR_THRESHOLD[0] && o.score <= NEAR_THRESHOLD[1],
  );
  const nearButUnsettled = nearThreshold.filter((o) => o.mode !== "solo");
  if (nearButUnsettled.length) {
    return {
      answerable: false,
      missing: [],
      needsIsolation: isolationOrder(
        { questions: [] },
        nearButUnsettled.map((o) => o.q),
      ),
      reason: `these questions are near the gate and were asked in a batch: ` +
              `${nearButUnsettled.map((o) => o.q).join(", ")}. A batched ` +
              `borderline score moves by up to 0.037, so it must be re-asked ` +
              `alone before it may gate.`,
    };
  }

  // PER-SOURCE THRESHOLDS, when the evidence comes from more than one
  // source.
  //
  // Two sources are not interchangeable, so a single threshold cannot
  // fairly judge both. The other agent measured this: "calibrating Jev
  // hurt it. For Workers AI, a per-source threshold matched the
  // isotonic map, so the gate gained source_thresholds."
  //
  // So each observation is compared against ITS OWN source's threshold
  // when the decision supplies one, and the decision passes only if
  // every source's own comparison passes. With one source, or with no
  // per-source thresholds, this is exactly the plain threshold.
  const perSource = [];
  if (sourceThresholds) {
    const bySource = new Map();
    for (const o of observed) {
      const key = o.source ?? "default";
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(o);
    }
    for (const [src, group] of bySource) {
      const t = sourceThresholds[src] ?? threshold;
      const weakestHere = group.slice().sort((a, b) => a.score - b.score)[0];
      perSource.push({
        source: src,
        threshold: t,
        confidence: Math.min(...group.map((o) => o.score)),
        pass: Math.min(...group.map((o) => o.score)) >= t,
        weakest: weakestHere.q,
      });
    }
  }

  // MIN, never a mean and never a weighted mean.
  const confidence = Math.min(...observed.map((o) => o.score));
  const weakest = observed.slice().sort((a, b) => a.score - b.score)[0];

  // The SPREAD of the weakest question, when it has been asked more
  // than once. A score is a sample, not a constant: measured 0.290 /
  // 0.360 / 0.370 on three repeats of the same question against the
  // same document -- a spread of 0.08 -- while the verdict never
  // moved. So a score sitting near a threshold is uncertain even when
  // every sample lands on the same side.
  const spread = Math.max(0, ...observed.map((o) => o.spread ?? 0));

  return {
    answerable: true,
    confidence,
    threshold,
    // With per-source thresholds, EVERY source must clear its OWN bar.
    pass: perSource.length ? perSource.every((p) => p.pass) : confidence >= threshold,
    perSource,
    spread,
    weakest: weakest.q,
    states: distinctStates(ledger, questionIds),
    observations: observed,
  };
}

/**
 * Answer a DERIVED question from the ledger alone.
 *
 * @param spec {id, requires, threshold, action, assertedEdges}
 *   requires     the question ids this answer rests on
 *   assertedEdges the EDGES the reasoning uses. These are NOT
 *                certified by anything -- they are the author's claim
 *                that these questions support each other -- and the
 *                receipt says so.
 */
export function deriveAnswer(graph, ledger, spec) {
  const questionIds = spec.requires ?? [];
  const v = verdictFromLedger(ledger, questionIds, spec.threshold ?? 0.5, {
    sourceThresholds: spec.sourceThresholds ?? null,
  });
  if (!v.answerable) {
    return {
      id: spec.id,
      answered: false,
      ...v,
      certified: 0,
      assertedEdges: spec.assertedEdges ?? [],
      receipt: `NOT ANSWERED: ${v.reason}`,
    };
  }
  const edges = spec.assertedEdges ?? [];
  return {
    id: spec.id,
    answered: true,
    confidence: v.confidence,
    threshold: v.threshold,
    pass: v.pass,
    weakest: v.weakest,
    certified: questionIds.length,
    assertedEdges: edges,
    states: v.states,
    spread: v.spread,
    perSource: v.perSource,
    observations: v.observations,
    receipt:
      `confidence ${v.confidence.toFixed(2)} against a threshold of ${v.threshold.toFixed(2)}, ` +
      `resting on ${questionIds.length} CERTIFIED question(s)` +
      (edges.length ? ` and ${edges.length} ASSERTED edge(s) nobody checked` : "") +
      `. All of it was read against ${v.states} document(s)` +
      (v.states === 1 && questionIds.length > 1
        ? ` -- so these are ${questionIds.length} readings of ONE document, not ${questionIds.length} independent witnesses.`
        : ".") +
      (v.perSource.length > 1
        ? ` Judged per source: ` +
          v.perSource.map((p) => `${p.source} ${p.confidence.toFixed(2)}/${p.threshold.toFixed(2)}`).join(", ") +
          `.`
        : "") +
      (v.spread > 0
        ? ` The weakest question's score has been observed with a spread of ${v.spread.toFixed(3)} -- a score is a SAMPLE, not a constant.`
        : ""),
  };
}

/**
 * The answer to a question that was ASKED, recomputed from the ledger.
 *
 * The closure property: this must equal the verdict reached with the
 * judge in the loop. If it does not, the ledger is not sufficient and
 * the derived answers built on it are not trustworthy either.
 */
export function replayDecision(graph, ledger, decisionId) {
  const d = graph.decisions.find((x) => x.id === decisionId);
  if (!d) throw new Error(`no decision ${decisionId}`);
  const v = verdictFromLedger(ledger, d.requires ?? [], d.threshold ?? 0.5);
  return {
    decision: decisionId,
    part: d.part,
    action: d.action,
    ...v,
    assertedEdges: (d.requires ?? []).length
      ? graph.parts.filter((p) => p.id === d.part).flatMap((p) => p.dependsOn ?? [])
      : [],
  };
}

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

import { observationOf, distinctStates, distinctExperts, correlation } from "./ledger.mjs";
import { isolationOrder } from "./qgraph.mjs";
import { NEAR_THRESHOLD } from "./guards.mjs";

// ---------------------------------------------------------------------
// THE NOISE BAND. Read this before you trust any gate below it.
// ---------------------------------------------------------------------
//
// MEASURED -- docs/MEASURED-JUDGE-NOISE.md, nine spec-reading claims,
// five repeats each, the same document every time:
//
//   crossed the gate    : 0/45 = 0.0%
//   adjacent-pair flips : 0/36 = 0.0%
//   score spread        : mean 0.007   median 0.000   MAX 0.020
//
// The headline number is 0/45, and reading only that would be a mistake:
// 0/45 is zero because the claims sat at 0.97-0.98 and 0.01-0.07, well
// clear of the gate. The one claim that wobbled, `losers are listed`,
// scored 0.910 0.920 0.930 0.920 0.910 -- a spread of 0.020 sitting
// EXACTLY in the 0.9 band where the other agent measured their GO/OPEN
// flips. And their measurement is the same one from the other side: ~7%
// of gates flip at 0.9 when re-asked.
//
// So the rule this module enforces is not "the judge is unreliable":
//
//   THE SCORE MOVES ~0.01-0.02 IN GENERAL, AND THAT IS ENOUGH TO PUSH A
//   SCORE SITTING NEAR A THRESHOLD ACROSS IT. A score within ~0.02 of a
//   threshold is a coin flip EVEN WHEN EVERY SAMPLE LANDED ON THE SAME
//   SIDE.
//
// 0.020 is therefore the floor on any sufficiency gate, and it is a
// floor taken from a MEASUREMENT rather than a preference. Any gate that
// claims to have decided something with less margin than this is not
// deciding; it is guessing and calling it a result.
export const NOISE_BAND = 0.02;

/** The measurement, carried as data so it can travel in the output. */
export const NOISE_MEASUREMENT =
  "docs/MEASURED-JUDGE-NOISE.md: 9 claims x 5 repeats against one document, " +
  "0/45 gate crossings, mean spread 0.007, median 0.000, MAX SPREAD 0.020. " +
  "The score moves ~0.01-0.02 in general, which is enough to push a score " +
  "sitting near a threshold across it, so a score within ~0.02 of a " +
  "threshold is a coin flip even when every sample landed on the same side.";

/**
 * Has enough been recorded to answer today's prompt?
 *
 * "JEV lets you know when you have enough questions to answer today's
 * prompt."
 *
 * THREE PROPERTIES, and each one is a refusal to do something easier:
 *
 *  1. IT IS DERIVED FROM THE LEDGER. No judge call, no expert call, no
 *     network. That is the closure property: everything the answer
 *     depends on is already recorded, so asking again would buy nothing
 *     and cost money. A sufficiency gate that had to call a judge to
 *     decide whether it had enough would be the opposite of the design.
 *
 *  2. IT RESPECTS THE MEASURED NOISE. If the deciding score sits inside
 *     the 0.01-0.02 band around the threshold, the answer is "not yet" --
 *     even when the score has passed, and even when every sample of that
 *     score landed on the same side. See NOISE_BAND above for the
 *     measurement, which is why the band is a floor and not a taste.
 *     The band is raised further by this question's OWN recorded spread
 *     when it has one, so a score we have watched wobble by 0.08 is
 *     never treated as a 0.02-stable one.
 *
 *  3. IT REPORTS A COUNT AND NEVER A CONFIDENCE. It reports how many
 *     documents and how many experts the evidence came from, separately,
 *     and it does NOT gate on that count -- because nothing here has
 *     verified that the documents are independent of each other or that
 *     two named experts did not train on the same corpus. Inventing an
 *     "independence score" out of a count the design cannot support is
 *     the one thing this module refuses to do.
 *
 * The verdict is a string, not a number: "sufficient" or "not-yet".
 * There is deliberately no third state that means "probably".
 */
export function sufficiency(ledger, questionIds, opts = {}) {
  const threshold = opts.threshold ?? 0.5;
  const sourceThresholds = opts.sourceThresholds ?? null;
  const band = opts.noiseBand ?? NOISE_BAND;

  const v = verdictFromLedger(ledger, questionIds, threshold, { sourceThresholds });
  const corr = correlation(ledger, questionIds);

  const base = {
    verdict: "not-yet",
    sufficient: false,
    threshold,
    // The band and where it came from, in the OUTPUT rather than only
    // in a comment, so a caller that reads this object alone still
    // knows how much of it is a measurement.
    noiseBand: band,
    noiseMeasurement: NOISE_MEASUREMENT,
    // THE TWO KINDS OF DEPENDENCE, SIDE BY SIDE. Never summed.
    documents: corr.documents,
    experts: corr.experts,
    correlation: corr,
    observed: corr.questions,
  };

  // 1. FAIL CLOSED on everything the ledger cannot support. Each of
  //    these names what is wrong instead of returning a soft no.
  if (!v.answerable) {
    const blocking = v.missing?.length ? "missing" : "unsafe";
    return {
      ...base,
      ...(v.missing?.length ? { missing: v.missing } : {}),
      ...(v.needsIsolation ? { needsIsolation: v.needsIsolation } : {}),
      blocking,
      reason: v.reason,
    };
  }

  // 2. WHICH SCORE DECIDES, AND BY HOW MUCH.
  //
  // With per-source thresholds the deciding score is the WORST margin
  // over the sources, not the minimum of the confidences: a decision
  // passes only if every source clears its own bar, so its margin is
  // the smallest of the per-source margins.
  const deciding = (v.perSource.length
    ? v.perSource.slice().sort((a, b) => (a.confidence - a.threshold) - (b.confidence - b.threshold))[0]
    : { confidence: v.confidence, threshold: v.threshold });
  const margin = Math.abs(deciding.confidence - deciding.threshold);

  // 3. THE EFFECTIVE BAND: the measured floor, raised by what this very
  //    question has been seen to do. A score with a recorded spread is
  //    not a score that deserves the general band's patience.
  const observedSpread = v.spread ?? 0;
  const effectiveBand = Math.max(band, observedSpread);
  const bandSource = observedSpread > band
    ? "the recorded spread of this evidence, which is wider than the measured judge noise"
    : "the measured judge noise";
  // The comparison carries an epsilon so the boundary FAILS CLOSED. In
  // binary floating point 0.92 - 0.90 is 0.020000000000000018, which is
  // "not <= 0.02" and would let a score sitting EXACTLY on the edge of
  // the measured band through as sufficient. "Within 0.02" includes
  // exactly 0.02, so exactly-on-the-edge is inside and is refused.
  const insideBand = margin <= effectiveBand + 1e-9;

  const fields = {
    ...base,
    margin,
    effectiveBand,
    bandSource,
    observedSpread,
    insideNoiseBand: insideBand,
    weakest: v.weakest,
    decidedBy: v.perSource.length ? deciding.source : "the ledger",
  };

  if (!v.pass) {
    return {
      ...fields,
      blocking: "below-threshold",
      reason: `the deciding score ${deciding.confidence.toFixed(2)} does not clear the ` +
        `threshold ${deciding.threshold.toFixed(2)}, by a margin of ${margin.toFixed(3)}.`,
    };
  }

  if (insideBand) {
    return {
      ...fields,
      blocking: "inside-noise-band",
      reason:
        `the deciding score ${deciding.confidence.toFixed(2)} clears the threshold ` +
        `${deciding.threshold.toFixed(2)} by only ${margin.toFixed(3)}, which is inside the ` +
        `noise band of ${effectiveBand.toFixed(3)} set by ${bandSource}. Measured: the score ` +
        `moves ~0.01-0.02 in general and that is enough to push a score sitting near a ` +
        `threshold across it, so this is NOT YET -- it is a coin flip that happened to land ` +
        `on the passing side. Get more margin, not another sample of the same score.`,
    };
  }

  return {
    ...fields,
    sufficient: true,
    verdict: "sufficient",
    blocking: null,
    reason: `the deciding score ${deciding.confidence.toFixed(2)} clears the threshold ` +
      `${deciding.threshold.toFixed(2)} by ${margin.toFixed(3)}, outside the noise band of ` +
      `${effectiveBand.toFixed(3)}. ${corr.caveat}`,
  };
}

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

  // THE TWO KINDS OF DEPENDENCE, REPORTED SEPARATELY. `states` stays
  // exactly what it was -- the document count -- and `experts` sits
  // beside it. They are never added together: a document and an expert
  // are different kinds of dependence, and a single "sources: 3" number
  // would hide which kind is carrying the evidence.
  const corr = correlation(ledger, questionIds);
  const margin = Math.abs(confidence - threshold);

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
    documents: corr.documents,
    experts: corr.experts,
    correlation: corr,
    // HOW FAR FROM THE LINE, and whether that distance is inside the
    // measured noise band. Carried on the verdict itself so that any
    // caller reading this object -- and not the docs -- can see that a
    // pass this close to the threshold is a coin flip.
    margin,
    insideNoiseBand: margin <= NOISE_BAND + 1e-9,
    noiseBand: NOISE_BAND,
    observations: observed,
  };
}

/**
 * THE CORPUS CLAUSE of a receipt: what it was read against, and what
 * that means about independence.
 *
 * Two branches, and the split is deliberate.
 *
 * With NO experts this is the sentence the project has always printed,
 * character for character: "All of it was read against N document(s) --
 * so these are M readings of ONE document, not M independent witnesses."
 * A ledger of documents produces a ledger of documents' receipt.
 *
 * With experts it has to be rebuilt rather than appended to. The old
 * clause counts EVERY required question as a reading of the ONE
 * document, and that stops being true the moment some of them were
 * answered by a professional: saying "2 readings of ONE document" when
 * one of the two came from counsel would attach the wrong provenance to
 * the wrong questions -- the exact failure `bindsTo` vs `decides` warns
 * about elsewhere in this file. So each kind of witness is named against
 * the questions that actually came from it.
 */
function corpusClause(questionIds, v, certBy) {
  const n = questionIds.length;
  if (!v.experts) {
    return `All of it was read against ${v.states} document(s)` +
      (v.states === 1 && n > 1
        ? ` -- so these are ${n} readings of ONE document, not ${n} independent witnesses.`
        : ".");
  }
  const what = [];
  if (v.states) what.push(`${v.states} document(s)`);
  what.push(`${v.experts} expert(s)` +
    (v.correlation.expertIds.length ? ` (${v.correlation.expertIds.join(", ")})` : ""));

  // "1 is a reading of ONE document" / "2 are readings of ONE expert"
  const reading = (count, of) =>
    `${count} ${count === 1 ? "is a reading" : "are readings"} of ${of}`;
  const notes = [];
  if (certBy.documents.length) {
    notes.push(reading(certBy.documents.length, v.states === 1 ? "ONE document" : `${v.states} documents`));
  }
  if (certBy.experts.length) {
    notes.push(reading(certBy.experts.length, v.experts === 1 ? "ONE expert" : `${v.experts} experts`));
  }
  return `All of it was read against ${what.join(" and ")}` +
    (n > 1
      ? ` -- so of these ${n} question(s), ${notes.join(" and ")}, not ${n} independent witnesses.`
      : ".") +
    // An expert is not five witnesses in a trenchcoat, and the count of
    // distinct experts says nothing at all about whether they disagree.
    ` An expert is not five witnesses in a trenchcoat: it is one respondent whose priors, training data and blind spots every answer shares, so asking one expert five times buys a tighter estimate of one opinion, not five opinions.`;
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

  // HOW MUCH IS CERTIFIED, AND FROM WHOM. This is not a new
  // distinction -- CERTIFIED and ASSERTED already exist in the graph and
  // are not reinvented here. What is added is only WHERE the certified
  // part came from, because a question read from a paid expert is
  // certified by a different kind of witness than one read from a
  // document, and a receipt that says "2 CERTIFIED" without saying that
  // is hiding the very thing this ledger exists to surface.
  const certBy = { documents: [], experts: [] };
  for (const o of v.observations) {
    if (o.expert) certBy.experts.push(o);
    else certBy.documents.push(o);
  }

  // THE NOISE, IN THE OUTPUT. Not in a comment, not only in the docs --
  // in the receipt, because the receipt is the thing somebody acts on.
  const suff = sufficiency(ledger, questionIds, {
    threshold: spec.threshold ?? 0.5,
    sourceThresholds: spec.sourceThresholds ?? null,
    noiseBand: spec.noiseBand ?? NOISE_BAND,
  });

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
    // The two kinds of dependence, side by side, never combined.
    documents: v.documents,
    experts: v.experts,
    expertIds: v.correlation.expertIds,
    correlation: v.correlation,
    // WHERE each certified question came from.
    certifiedFrom: {
      documents: certBy.documents.map((o) => o.q),
      experts: certBy.experts.map((o) => o.q),
      expertIds: v.correlation.expertIds,
    },
    // What the paid experts cost and took, when there were any. A
    // receipt that does not carry the price is not a receipt for work
    // that cost money.
    expertSpend: {
      calls: v.observations.filter((o) => o.expert).length,
      cost: v.observations.filter((o) => o.expert && o.cost != null)
        .reduce((sum, o) => sum + (typeof o.cost === "number" ? o.cost : (o.cost?.amount ?? 0)), 0),
      latencyMs: v.observations.filter((o) => o.expert && o.latencyMs != null)
        .reduce((m, o) => Math.max(m, o.latencyMs), 0),
    },
    spread: v.spread,
    perSource: v.perSource,
    // THE SUFFICIENCY VERDICT, on the answer itself.
    sufficient: suff.sufficient,
    noiseBand: suff.noiseBand,
    margin: suff.margin,
    insideNoiseBand: suff.insideNoiseBand,
    sufficiency: suff,
    observations: v.observations,
    receipt:
      `confidence ${v.confidence.toFixed(2)} against a threshold of ${v.threshold.toFixed(2)}, ` +
      `resting on ${questionIds.length} CERTIFIED question(s)` +
      (edges.length ? ` and ${edges.length} ASSERTED edge(s) nobody checked` : "") +
      `. ` + corpusClause(questionIds, v, certBy) +
      (v.perSource.length > 1
        ? ` Judged per source: ` +
          v.perSource.map((p) => `${p.source} ${p.confidence.toFixed(2)}/${p.threshold.toFixed(2)}`).join(", ") +
          `.`
        : "") +
      (v.spread > 0
        ? ` The weakest question's score has been observed with a spread of ${v.spread.toFixed(3)} -- a score is a SAMPLE, not a constant.`
        : "") +
      // THE NOISE CAVEAT IS IN THE RECEIPT, not only in the docs.
      (suff.insideNoiseBand
        ? ` NOT SUFFICIENT YET: that score clears the threshold by ${suff.margin.toFixed(3)}, ` +
          `inside the noise band of ${suff.effectiveBand.toFixed(3)}. The score moves ~0.01-0.02 ` +
          `in general -- measured, 9 claims x 5 repeats, 0/45 gate crossings, max spread 0.020 -- ` +
          `and that is enough to push a score sitting near a threshold across it. A pass this ` +
          `close is a coin flip that landed on the passing side.`
        : ` Noise band ${suff.effectiveBand.toFixed(3)} (measured, max spread 0.020 over 45 repeats): ` +
          `the deciding score clears the threshold by ${suff.margin.toFixed(3)}, outside it.`),
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

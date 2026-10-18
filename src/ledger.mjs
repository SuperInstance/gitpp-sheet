// The LEDGER: a durable record of what was asked, what was answered,
// and what the answer was read against.
//
// This is the piece that makes a chain of thought reusable. Today a
// fold's claims are scored once and the scores are thrown away, so the
// next question restarts from nothing. The ledger keeps the
// observations, their provenance, and the graph they belong to -- so
// the next question can be answered from what is already known.
//
// THE LEDGER'S CENTRAL CLAIM, and it is testable:
//
//   A ledger is SUFFICIENT. Everything a decision's verdict depends on
//   is in the ledger, so the verdict can be reproduced from the ledger
//   with no judge call at all. If that is true, then a question nobody
//   asked can also be answered from the ledger, and the expensive part
//   (observing) and the cheap part (recombining) come apart.
//
// The corollary is the interesting one. If the ledger is sufficient,
// then a SMALL model -- or no model, just a rule engine -- can read the
// ledger and answer questions the big model asked. The big model's job
// shrinks to authoring the graph; the judge's job shrinks to producing
// the observations; and everything downstream is arithmetic.
//
// THE RECEIPT FORMAT. The user-facing question was whether a system
// could answer from "just a JEV percentage, or raw data read with the
// right parsing". The answer here is NO, and it is worth being exact
// about why.
//
// A bare score is not safe to read. Measured on this project's own
// spec, a FALSE claim scores 0.01 against a clean document and 0.86
// against a document with one contradicting clause appended -- the same
// number space, and the difference is invisible in the number. A score
// is only meaningful TOGETHER WITH the state it was read against, the
// guards that were applied, and whether it was asked alone.
//
// So the ledger stores the ADJUDICATED observation, not the raw score:
// the score AND the verdict AND the provenance. A consumer that reads
// the verdict is safe; a consumer that reads the score alone is not.
// That is the "right parsing".

import { stateHash, graphHeader } from "./qgraph.mjs";
import { buildSheet } from "./sheet.mjs";

/**
 * An empty ledger for a graph.
 */
export function createLedger(graph, fold = null) {
  return {
    header: graphHeader(graph),
    fold: fold ?? null,
    // questionId -> the most recent observation
    observations: new Map(),
    // every observation, in order -- the history
    history: [],
  };
}

/**
 * Record one observation.
 *
 * The observation is the WHOLE receipt, not just the number:
 *
 *   score      what the judge said
 *   verdict    what the GUARDS made of it (supported / not-supported /
 *              needs-isolation / unreliable / contradicted)
 *   mode       "solo" or "batched" -- and this travels with the data,
 *              because a batched borderline score moves by up to 0.037
 *              while a solo one reproduces to within 0.005
 *   stateHash  which document it was read against
 *   state      the document itself, kept so the ledger can be replayed
 *              and so a reader can see what was actually asked
 */
export function recordObservation(ledger, obs) {
  if (!obs || !obs.q) throw new Error("an observation needs a question id");
  if (obs.score === undefined || obs.score === null) {
    throw new Error(`observation for ${obs.q} has no score`);
  }
  const state = obs.state ?? null;
  const rec = {
    q: obs.q,
    score: obs.score,
    verdict: obs.verdict ?? null,
    reason: obs.reason ?? null,
    mode: obs.mode ?? "solo",
    stateHash: obs.stateHash ?? stateHash(state),
    state,
    at: obs.at ?? null,
  };
  const next = {
    ...ledger,
    observations: new Map(ledger.observations),
    history: [...ledger.history, rec],
  };
  next.observations.set(rec.q, rec);
  return next;
}

/** The most recent observation of a question, or null. */
export function observationOf(ledger, questionId) {
  return ledger.observations.get(questionId) ?? null;
}

/**
 * How many DISTINCT documents a set of questions was read against.
 *
 * This is the correlation signal, and it is the one number a mean
 * confidence cannot give you.
 *
 * Five questions scored against one document are FIVE READINGS OF ONE
 * DOCUMENT. They are not five independent witnesses, and if the
 * document is wrong they are wrong together. A decision that rests on
 * five questions over three documents is better evidenced than one
 * that rests on five questions over one -- but ONLY IF the three
 * documents are independent, which the graph asserts and nothing
 * verifies. The number is therefore reported as a count with the
 * caveat attached, not as a confidence.
 */
export function distinctStates(ledger, questionIds) {
  const hashes = new Set();
  for (const id of questionIds) {
    const o = observationOf(ledger, id);
    if (o) hashes.add(o.stateHash);
  }
  return hashes.size;
}

/**
 * Materialise the graph and the ledger into the sheet, WITH the
 * provenance.
 *
 * The cell confidence itself is computed by `buildSheet`, which is the
 * tested implementation and stays the single source of truth. What is
 * added here is the part the sheet could not carry:
 *
 *   - which questions support each cell
 *   - which DOCUMENT each of those was read against
 *   - whether the questions of a decision were read against one
 *     document or several
 *   - which parts are certified and which are merely asserted
 */
export function materialise(graph, fold, ledger) {
  // The confidence maps `buildSheet` consumes, taken from the graph's
  // decisions rather than from a flat claim list.
  const claims = {};
  const priors = {};
  const provenance = {};

  for (const d of graph.decisions) {
    const reqs = (d.requires ?? []).map((id) => observationOf(ledger, id)).filter(Boolean);
    if (!reqs.length) continue;
    // MIN, never a mean and never a weighted mean. One weak link is
    // the whole link.
    const conf = Math.min(...reqs.map((o) => o.score));
    // A decision whose questions are ALL unsupported is not evidence at
    // all, and must not lower a cell's confidence on the strength of
    // being wrong. A decision that FAILED is not a weak decision; it
    // is a decision that did not happen.
    const supported = reqs.filter((o) => o.verdict === "supported" || o.verdict === null);
    if (!supported.length) continue;
    const supportedConf = Math.min(...supported.map((o) => o.score));

    // The CONFLICTS the decision settles become the sheet's claims.
    //
    // `buildSheet` looks a claim up by "<key>:<winner>:<loser>", so the
    // key has to be the CONTEST, not the cell. A decision that does
    // not declare `decides` does not settle a contest and does not
    // change a cell's confidence -- it may still be evidence, and it
    // still shows up in the provenance.
    for (const dec of d.decides ?? []) {
      const ck = `${dec.key}:${dec.winner}:${dec.loser ?? ""}`;
      claims[ck] = Math.min(claims[ck] ?? 1, supportedConf);
    }
    for (const [rid, score] of Object.entries(d.priors ?? {})) {
      priors[rid] = Math.min(priors[rid] ?? 1, supportedConf);
    }

    // The keys a decision speaks to are the UNION of the keys its
    // required QUESTIONS bind to, plus the keys it decides. `bindsTo`
    // says which cells a question is ABOUT; `decides` says which
    // contest a decision SETTLES. Conflating them attaches provenance
    // to the wrong cells.
    const keys = new Set();
    for (const qid of d.requires ?? []) {
      const q = graph.questions.find((x) => x.id === qid);
      for (const k of q?.bindsTo ?? []) keys.add(k);
    }
    for (const dec of d.decides ?? []) keys.add(dec.key);

    for (const key of keys) {
      provenance[key] = provenance[key] ?? { questions: [], decisions: [] };
      provenance[key].questions.push(...reqs.map((o) => o.q));
      provenance[key].decisions.push({
        id: d.id, part: d.part, confidence: supportedConf,
        states: distinctStates(ledger, d.requires ?? []),
        requires: d.requires ?? [],
      });
    }
  }

  const sheet = buildSheet(fold, claims, priors);

  // Attach the provenance to the cells.
  for (const cell of sheet.cells) {
    const p = provenance[cell.key];
    cell.questions = p ? [...new Set(p.questions)] : [];
    cell.decisionsFromGraph = p ? p.decisions : [];
    cell.distinctStates = p ? p.decisions.reduce((n, d) => Math.max(n, d.states), 0) : 0;
  }

  return { sheet, provenance };
}

/**
 * The per-part view: which parts are certified, how strongly, and how
 * many documents their evidence came from.
 *
 * A part with NO observations is ASSERTED, not certified. It is not
 * wrong -- it has simply not been checked, and the report says so
 * rather than implying a confidence of zero.
 */
export function partStatus(graph, ledger) {
  return graph.parts.map((p) => {
    const qs = graph.questions.filter((q) => q.part === p.id);
    const obs = qs.map((q) => observationOf(ledger, q.id)).filter(Boolean);
    const certified = obs.filter((o) => o.verdict === "supported");
    const weights = qs.filter((q) => q.weight > 0);
    return {
      id: p.id,
      statement: p.statement,
      dependsOn: p.dependsOn ?? [],
      questions: qs.map((q) => q.id),
      weightMass: weights.reduce((s, q) => s + q.weight, 0),
      observed: obs.length,
      certified: certified.length,
      states: distinctStates(ledger, qs.map((q) => q.id)),
      // The confidence of a part is the MINIMUM over its CERTIFIED
      // questions -- a part with nothing certified has no confidence at
      // all, and saying 1.0 would be a lie.
      confidence: certified.length ? Math.min(...certified.map((o) => o.score)) : null,
      status: certified.length ? "certified" : (obs.length ? "observed-not-certified" : "asserted"),
    };
  });
}

/**
 * The ledger as flat rows: the "raw data" form.
 *
 * One row per observation, with everything needed to read it safely.
 * A consumer that wants a number reads `score`; a consumer that wants
 * to be SAFE reads `verdict`. The column set is the point.
 */
export function toRows(ledger) {
  return ledger.history.map((o, i) => ({
    i,
    q: o.q,
    score: o.score,
    verdict: o.verdict,
    mode: o.mode,
    stateHash: o.stateHash,
    at: o.at,
  }));
}

/**
 * Rebuild a ledger from its rows and a graph.
 *
 * The round-trip is the point: a ledger that cannot be read back is not
 * a durable artifact, it is a log. The states are NOT restored from
 * the rows -- they are taken from the graph, which is where the
 * documents live. A row is evidence ABOUT a question; the question
 * owns the document.
 */
export function fromRows(graph, rows) {
  let ledger = createLedger(graph);
  const byId = new Map(graph.questions.map((q) => [q.id, q]));
  for (const r of rows) {
    const q = byId.get(r.q);
    ledger = recordObservation(ledger, {
      q: r.q,
      score: r.score,
      verdict: r.verdict,
      reason: r.reason,
      mode: r.mode,
      stateHash: r.stateHash,
      state: q?.state ?? null,
      at: r.at,
    });
  }
  return ledger;
}

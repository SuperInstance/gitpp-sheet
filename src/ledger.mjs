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

import { stateHash, graphHeader, expertOf, expertHash, isExpertState } from "./qgraph.mjs";
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
 * THE WHOLE RECEIPT, not just the number. The record is now:
 *
 *   q          which question
 *   score      what the judge said
 *   verdict    what the GUARDS made of it (supported / not-supported /
 *              needs-isolation / unreliable / contradicted)
 *   reason     why they said that
 *   mode       "solo" or "batched" -- and this travels with the data,
 *              because a batched borderline score moves by up to 0.037
 *              while a solo one reproduces to within 0.005
 *   source     which judge service, for per-source thresholds
 *   spread     how far this score has moved over repeats
 *   stateHash  WHICH CORPUS it was read against -- the document, or the
 *              expert's identity plus the request sent
 *   state      the corpus itself, kept so the ledger can be replayed and
 *              a reader can see what was actually asked
 *   at         when
 *
 * and, when the corpus is a PAID EXPERT rather than a document:
 *
 *   corpus     "expert" (derived from the state, never taken on trust)
 *   expert     {id, model, endpoint} -- the named professional
 *   expertHash the correlation key: WHO it is, WITHOUT the request, so
 *              five questions to one expert are five readings of one
 *              expert rather than five independent witnesses
 *   request    the exact request sent
 *   response   the expert's ANSWER, verbatim. This is the field that
 *              does not exist for a document: a judge returns a number
 *              and the number is all there is, but an expert returns
 *              TEXT and the text is the thing that was paid for
 *   cost       what it cost
 *   latencyMs  how long it took
 *
 * All four expert fields are null for a document reading, so the record
 * of a document reading is byte-for-byte what it always was.
 */
export function recordObservation(ledger, obs) {
  if (!obs || !obs.q) throw new Error("an observation needs a question id");
  if (obs.score === undefined || obs.score === null) {
    throw new Error(`observation for ${obs.q} has no score`);
  }
  const state = obs.state ?? null;

  // -------------------------------------------------------------------
  // WHICH CORPUS, AND WHO WAS IT
  // -------------------------------------------------------------------
  //
  // A document answer stores the request document and gives back a
  // NUMBER, because that is all a judge returns. A paid expert gives
  // back TEXT, and text is what has to survive: the whole point of paying
  // for the answer is that a later question can be re-derived from it
  // without paying again. So when the corpus is an expert the record
  // additionally carries the whole exchange -- what was sent, what came
  // back, what it cost, and how long it took.
  //
  // The three money-bearing fields are the difference between a receipt
  // and a log line: `cost` and `latencyMs` are what let a reader see
  // that five questions answered by one expensive expert were five reads
  // of one witness, paid for five times.
  const expert = expertOf(state) ?? (obs.expert ? expertOf({ expert: obs.expert }) : null);
  if (expert && (typeof expert.id !== "string" || !expert.id.trim())) {
    throw new Error(`observation for ${obs.q} names an expert with no usable id. ` +
      `An expert nobody can name is not a witness: two unnamed experts cannot ` +
      `be told apart, so the correlation count would be a lie with nothing to ` +
      `catch it.`);
  }
  const corpus = expert ? "expert" : "document";

  // The request actually sent. A state MAY carry it as `ask`; when it
  // does not, the caller may pass it per call, because two calls may ask
  // the same expert different things.
  const request = obs.request !== undefined && obs.request !== null
    ? obs.request
    : (typeof state?.ask === "string" ? state.ask : null);
  const response = obs.response ?? null;
  const cost = obs.cost ?? null;
  const latencyMs = obs.latencyMs ?? null;

  // The fingerprint a repeat is compared against.
  //
  // For a DOCUMENT this is the hash of the document, exactly as before.
  // For an EXPERT it is the hash of the expert's IDENTITY PLUS THE
  // REQUEST, because a different question sent to the same expert is a
  // different measurement -- not another sample of this one. Note what
  // is NOT here: `expertHash` deliberately excludes the request, so the
  // CORRELATION key says "one expert" while the SPREAD key says "one
  // question, asked one way".
  const fingerprint = expert ? { expert, request } : state;

  const rec = {
    q: obs.q,
    score: obs.score,
    verdict: obs.verdict ?? null,
    reason: obs.reason ?? null,
    mode: obs.mode ?? "solo",
    // WHO answered. Two sources are not interchangeable: the other
    // agent's gate learned this the hard way -- "calibrating Jev hurt
    // it. For Workers AI, a per-source threshold matched the isotonic
    // map" -- so a decision whose evidence comes from two sources
    // cannot compare them on one scale.
    source: obs.source ?? null,
    // The SPREAD of the score, when the same question has been asked
    // more than once against the same evidence.
    //
    // A score is a SAMPLE, not a constant. Measured: the same question
    // against the same document gave 0.290, 0.360, 0.370 on three
    // repeats -- a spread of 0.08, while the VERDICT never moved. So a
    // threshold set close to the score is genuinely uncertain even
    // when every sample lands on the same side of the gate.
    //
    // The ledger DERIVES this from its own history rather than asking
    // the caller to supply it: the ledger is the thing that knows what
    // it has seen, and a caller that computes the spread for itself
    // would have to get the comparison key right.
    spread: null,   // filled in below, once the stateHash is known
    stateHash: obs.stateHash ?? stateHash(fingerprint),
    state,
    at: obs.at ?? null,

    // -----------------------------------------------------------------
    // THE EXPERT EXTENSION. All four are null for a document read, so
    // the record of a document reading is UNCHANGED -- same keys, same
    // values -- and a ledger of documents behaves exactly as before.
    // -----------------------------------------------------------------
    // WHICH CORPUS. Never stored from the caller: it is derived from the
    // state, so a row cannot claim to be a document reading when the
    // state it names is an expert.
    corpus,
    // WHO ANSWERED. The named professional: id, model, endpoint.
    expert,
    // The correlation key: the expert's identity, WITHOUT the request.
    expertHash: expertHash(expert),
    // The exchange. `response` is the expert's TEXT, kept verbatim --
    // a receipt whose text was summarised is not a receipt.
    request,
    response,
    cost,
    latencyMs,
  };
  // The spread is computed against the readings of the SAME question
  // against the SAME corpus. A different document is a different
  // measurement, not another sample of this one -- and for an expert, so
  // is a different request to the same expert, which is why the
  // fingerprint above carries the request.
  const prior = ledger.history.filter(
    (o) => o.q === rec.q && o.stateHash === rec.stateHash,
  ).map((o) => o.score);
  rec.spread = prior.length
    ? Math.max(...prior, rec.score) - Math.min(...prior, rec.score)
    : (obs.spread ?? null);

  const next = {
    ...ledger,
    observations: new Map(ledger.observations),
    history: [...ledger.history, rec],
  };
  // THE LATEST READING WINS. Never the best one.
  //
  // The other agent found this the hard way: "a path's latest reading
  // now replaces earlier ones. Keeping the best reading let callers
  // re-ask until a gate passed."
  //
  // That is a way of LAUNDERING A FLAKY JUDGE INTO A CONFIDENT
  // VERDICT, and it is the single most tempting thing to build: keep
  // the reading that agrees with you, and the answer stops moving.
  //
  // The history keeps EVERY reading, so the spread is recoverable and
  // the fact that it moved is visible. The current reading is simply
  // the most recent one.
  next.observations.set(rec.q, rec);
  return next;
}

/**
 * Every reading of a question, oldest first.
 *
 * The history is not bookkeeping. It is the evidence that a score is
 * a SAMPLE: measured, the same question against the same document gave
 * 0.290, 0.360 and 0.370 on three repeats -- a spread of 0.08 -- while
 * the verdict never moved. A reader who wants to know how firm an
 * answer is reads this, not the score.
 */
export function readingsOf(ledger, questionId) {
  return ledger.history.filter((o) => o.q === questionId);
}

/**
 * The observed spread of a question's score, or 0 if it was asked once.
 */
export function spreadOf(ledger, questionId) {
  const s = readingsOf(ledger, questionId).map((o) => o.score);
  if (s.length < 2) return 0;
  return Math.max(...s) - Math.min(...s);
}

/** The most recent observation of a question, or null. */
export function observationOf(ledger, questionId) {
  return ledger.observations.get(questionId) ?? null;
}

/**
 * THE CORRELATION SIGNAL, generalised: how many DISTINCT DOCUMENTS and
 * how many DISTINCT EXPERTS a set of questions was read against.
 *
 * This is the number a mean confidence cannot give you, and it comes in
 * two kinds now:
 *
 *   Five questions scored against ONE DOCUMENT are FIVE READINGS OF ONE
 *   DOCUMENT. They are not five independent witnesses, and if the
 *   document is wrong they are wrong together.
 *
 *   Five questions answered by ONE EXPERT are FIVE READINGS OF ONE
 *   EXPERT -- for the same reason, and it is worth being exact about
 *   WHY. An expert is not five witnesses in a trenchcoat: it is one
 *   respondent whose priors, training data and blind spots every answer
 *   shares. Asking one expert five times buys a tighter estimate of one
 *   opinion, not five opinions.
 *
 * WHY THE TWO ARE NEVER AVERAGED TOGETHER. They are different kinds of
 * dependence and they fail in different ways. A document can be the
 * wrong revision; an expert can be wrong consistently across every
 * question. Combining them into "3 sources" would let three documents
 * and three experts look like six independent witnesses when they are
 * at most two kinds of witness, and would hide which kind is carrying
 * the evidence. So the object carries BOTH counts, always, and neither
 * of them is ever added into a single "independence" score.
 *
 * WHY IT IS A COUNT AND NOT A CONFIDENCE. A decision resting on five
 * questions over three documents is better evidenced than one resting on
 * five questions over one -- but ONLY IF the three documents are
 * independent, which the graph ASSERTS and nothing verifies. The same
 * caveat applies to experts, and more sharply: nothing here checks that
 * two named experts did not train on the same corpus. So this stays a
 * COUNT, reported with its caveat attached, and never becomes a number
 * something may gate on.
 */
export function correlation(ledger, questionIds) {
  const documents = new Set();
  const experts = new Set();
  const seen = [];
  for (const id of questionIds) {
    const o = observationOf(ledger, id);
    if (!o) continue;
    seen.push(o);
    if (o.expert) experts.add(o.expertHash);
    else documents.add(o.stateHash);
  }
  const out = {
    questions: seen.length,
    documents: documents.size,
    experts: experts.size,
    // The named experts, so a receipt can say WHICH professional was
    // leaned on. Names are cheap and they are the part a human needs.
    expertIds: [...experts].length
      ? [...seen].filter((o) => o.expert).map((o) => o.expert.id).filter((v, i, a) => a.indexOf(v) === i)
      : [],
  };
  out.caveat =
    `${out.questions} question(s) were read against ${out.documents} document(s) ` +
    `and ${out.experts} expert(s), counted SEPARATELY and never combined: ` +
    `a document and an expert are different kinds of dependence, and this ` +
    `count is a COUNT, not a confidence -- the graph ASSERTS the witnesses ` +
    `are independent and nothing here verifies it.`;
  return out;
}

/**
 * How many DISTINCT DOCUMENTS a set of questions was read against.
 *
 * Unchanged for a ledger of documents: this is a count of distinct
 * document fingerprints and nothing else.
 *
 * Expert readings are deliberately NOT counted here. Before there were
 * experts, every observation was a document, so "count the distinct
 * states" and "count the distinct documents" were the same statement.
 * They stop being the same the moment a question can be read against a
 * paid expert: an expert observation has no document, and its request
 * hash would otherwise be counted as one -- which would make a ledger
 * read against a single expensive expert look like N independent
 * witnesses, precisely inverting the signal this function exists to
 * give. Documents and experts are counted by `correlation()`, side by
 * side, and `distinctStates` keeps the meaning its own name promises.
 */
export function distinctStates(ledger, questionIds) {
  const hashes = new Set();
  for (const id of questionIds) {
    const o = observationOf(ledger, id);
    if (o && !o.expert) hashes.add(o.stateHash);
  }
  return hashes.size;
}

/**
 * How many DISTINCT EXPERTS a set of questions was answered by.
 *
 * The same signal as `distinctStates`, over the other kind of corpus.
 * The key is `expertHash`, which is the expert's IDENTITY and not its
 * request -- so five different questions put to one professional come
 * back as 1, which is the true answer.
 */
export function distinctExperts(ledger, questionIds) {
  const hashes = new Set();
  for (const id of questionIds) {
    const o = observationOf(ledger, id);
    if (o && o.expert) hashes.add(o.expertHash);
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
      const corr = correlation(ledger, d.requires ?? []);
      provenance[key].decisions.push({
        id: d.id, part: d.part, confidence: supportedConf,
        states: corr.documents,
        documents: corr.documents,
        experts: corr.experts,
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
    // The same reduction over the other kind of corpus. Kept beside
    // `distinctStates` and never merged with it.
    cell.distinctExperts = p ? p.decisions.reduce((n, d) => Math.max(n, d.experts ?? 0), 0) : 0;
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
      // The two kinds of dependence, side by side. `states` is still the
      // document count and always was; `experts` is the new one.
      documents: distinctStates(ledger, qs.map((q) => q.id)),
      experts: distinctExperts(ledger, qs.map((q) => q.id)),
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
    source: o.source,
    spread: o.spread,
    stateHash: o.stateHash,
    at: o.at,
    // WHICH CORPUS, so a reader of the raw rows can tell a document
    // reading from a paid expert's without parsing a hash.
    corpus: o.corpus,
    expert: o.expert,
    expertHash: o.expertHash,
    // THE TEXT. A row that keeps the score but drops the expert's
    // answer is not raw data, it is the number the answer was reduced
    // to -- and reducing it is the loss of provenance this ledger is
    // built to prevent.
    request: o.request,
    response: o.response,
    cost: o.cost,
    latencyMs: o.latencyMs,
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
      source: r.source,
      spread: r.spread,
      stateHash: r.stateHash,
      state: q?.state ?? null,
      // The EXPERT EXCHANGE rides along with the row. `state` comes
      // from the graph -- the question owns its corpus -- but what was
      // SENT and what came BACK belongs to the reading, so it is read
      // from the row. The expert's TEXT is the artefact; losing it on a
      // round trip would mean the ledger can be rebuilt but not read.
      request: r.request ?? undefined,
      response: r.response ?? null,
      cost: r.cost ?? null,
      latencyMs: r.latencyMs ?? null,
    });
  }
  return ledger;
}

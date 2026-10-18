// A chain of thought as a GRAPH OF QUESTIONS.
//
// The substrate already has most of the pieces: `claims.mjs` extracts
// the questions a fold implies, `guards.mjs` says how a judge may be
// trusted, `sheet.mjs` turns decisions into cells with confidence, and
// `triggers.mjs` gates an action. What is missing is the STRUCTURE --
// and the structure is what makes the rest durable.
//
// Today a chain of thought is a FLAT list of claims, scored once, and
// then thrown away. Nothing survives the run. The sheet that comes out
// holds cell confidence but not WHY, and the scores that produced it
// are gone, so a new question needs a new judge call for everything.
//
// A question graph fixes that by separating three things that are
// currently conflated:
//
//   CERTIFIED  a question asked of a document, with a verdict. This is
//              the only part a judge can speak to.
//   ASSERTED   an edge: "this part depends on that part". The judge
//              cannot verify an inference -- it reads text, it does not
//              do logic -- so an edge is AUTHORED, never certified.
//   OBSERVED   the score, and the provenance of the score: which
//              document it was read against, and whether it was asked
//              alone or in a batch.
//
// The distinction is the whole point. A receipt that says "0.94" and a
// receipt that says "0.94, certified against SPEC.md, asked alone, and
// resting on one asserted edge nobody checked" are different objects,
// and only the second one is worth acting on.
//
// WHAT THIS BUYS, concretely:
//
//   1. A DERIVED question -- one nobody asked -- can be answered from
//      the recorded observations, with NO new judge call. That is the
//      "answer many other questions" capability, and it is what lets a
//      small model (or a rule engine) do work that used to need a big
//      one.
//   2. The RECEIPT of a derived answer says how much of it is
//      certified and how much is merely asserted.
//
// The rule the rest of this project already learned, applied here:
// confidence is a MINIMUM, never a mean, and a WEIGHT NEVER ENTERS THE
// CONFIDENCE NUMBER. A mean hides one weak link behind many strong
// ones. A weighted mean is the same lie with extra steps.
//
// Weights have exactly four jobs, and none of them is "compute a
// score":
//
//   1. weight > 0 means the question is real evidence. weight 0 means
//      "asked, but does not count".
//   2. Isolation order. When several questions are near the gate, the
//      highest-weight one is re-asked first, because re-asking it is
//      what is most likely to change the verdict.
//   3. Blast radius. If question q is wrong, which decisions and parts
//      inherit the error -- weighted, so the report can rank them.
//   4. Reporting. The weight mass of a part, for a human reading it.
//
// WEIGHTS ARE NOT A CONFIDENCE. The confidence of a decision is the
// minimum confidence of the questions it requires. Full stop.

import { isAggregateClaim, hasQuantity } from "./guards.mjs";
import { createHash } from "node:crypto";

/** The kinds of question a judge is measured to answer differently. */
export const QUESTION_KINDS = ["atomic", "aggregate", "quantity"];

/**
 * A stable fingerprint of a state document.
 *
 * Two questions scored against the same state are not two independent
 * witnesses: they are two readings of the SAME document. The ledger
 * records this hash so a consumer can tell the difference -- and the
 * difference is large. Five questions over one document are five
 * readings, not five pieces of evidence.
 */
export function stateHash(state) {
  const s = typeof state === "string" ? state : JSON.stringify(state ?? null);
  return "sha256:" + createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function fail(msg) {
  const e = new Error(msg);
  e.name = "GraphError";
  throw e;
}

/**
 * Define a question graph.
 *
 * @param spec {parts, questions, decisions}
 *   parts      [{id, statement, dependsOn}]      the chain of thought
 *   questions  [{id, part, text, state, weight, bindsTo, kind}]
 *   decisions  [{id, part, requires, threshold, action}]
 */
export function defineGraph(spec) {
  const parts = spec.parts ?? [];
  const questions = spec.questions ?? [];
  const decisions = spec.decisions ?? [];

  const partIds = new Set();
  for (const p of parts) {
    if (!p.id) fail("every part needs an id");
    if (partIds.has(p.id)) fail(`duplicate part id: ${p.id}`);
    partIds.add(p.id);
  }

  const qIds = new Set();
  for (const q of questions) {
    if (!q.id) fail("every question needs an id");
    if (qIds.has(q.id)) fail(`duplicate question id: ${q.id}`);
    qIds.add(q.id);
    if (!partIds.has(q.part)) fail(`question ${q.id} names part ${q.part}, which does not exist`);
    if (!q.text) fail(`question ${q.id} has no text`);
    if (q.state === undefined || q.state === null) {
      fail(`question ${q.id} has no state. A question with no state is answered ` +
           `from the judge's own beliefs at ~0.6, which is indistinguishable from ` +
           `a confident reading of a document.`);
    }
    // The kind is DERIVED from the text by the measured rules, and may be
    // overridden -- but the override is recorded, because an override is
    // a place where someone can be wrong.
    const derived = isAggregateClaim(q.text) ? "aggregate"
      : hasQuantity(q.text) ? "quantity"
      : "atomic";
    q.kind = q.kind ?? derived;
    if (!QUESTION_KINDS.includes(q.kind)) {
      fail(`question ${q.id} has kind ${q.kind}; expected one of ${QUESTION_KINDS.join(", ")}`);
    }
    q.kindWasOverridden = q.kind !== derived;
    q.weight = q.weight === undefined ? 1 : q.weight;
    if (!(q.weight >= 0 && q.weight <= 1)) fail(`question ${q.id} has weight ${q.weight}; expected 0..1`);
    q.bindsTo = q.bindsTo ?? [];
  }

  const dIds = new Set();
  for (const d of decisions) {
    if (!d.id) fail("every decision needs an id");
    if (dIds.has(d.id)) fail(`duplicate decision id: ${d.id}`);
    dIds.add(d.id);
    if (d.part && !partIds.has(d.part)) fail(`decision ${d.id} names part ${d.part}, which does not exist`);
    for (const r of d.requires ?? []) {
      if (!qIds.has(r)) fail(`decision ${d.id} requires question ${r}, which does not exist`);
    }
    d.threshold = d.threshold ?? 0.5;
    // `decides` says which CONFLICT the decision settles. `bindsTo` on a
    // question says which cells the question is ABOUT. They are
    // different: a question can be about a cell without deciding it,
    // and a decision settles a specific (key, winner, loser) contest.
    // Conflating them produces a sheet whose provenance is attached to
    // the wrong cells.
    d.decides = d.decides ?? [];
    for (const dec of d.decides) {
      if (!dec.key) fail(`decision ${d.id} decides a contest with no key`);
      if (!dec.winner) fail(`decision ${d.id} decides a contest with no winner`);
    }
    d.priors = d.priors ?? {};
  }

  // The chain of thought must be acyclic. A cycle among PARTS is a
  // different thing from a cycle among RECORDS: the fold has a rule for
  // those (spec 5.4), and this is not it. A part that depends on
  // itself is a part whose reasoning is circular, and no amount of
  // scoring makes that sound.
  assertAcyclic(parts);

  return { parts, questions, decisions };
}

/** The chain of thought must be a DAG. */
export function assertAcyclic(parts) {
  const state = new Map();     // id -> "visiting" | "done"
  const visit = (id, path) => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      fail(`the chain of thought has a cycle: ${[...path, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    const p = parts.find((x) => x.id === id);
    for (const dep of p?.dependsOn ?? []) {
      if (!parts.some((x) => x.id === dep)) fail(`part ${id} depends on ${dep}, which does not exist`);
      visit(dep, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const p of parts) visit(p.id, []);
  return true;
}

/** The questions asked about one part. */
export function questionsOf(graph, partId) {
  return graph.questions.filter((q) => q.part === partId);
}

/** The questions a decision rests on, in graph order. */
export function requiredQuestions(graph, decisionId) {
  const d = graph.decisions.find((x) => x.id === decisionId);
  if (!d) fail(`no decision ${decisionId}`);
  return (d.requires ?? [])
    .map((id) => graph.questions.find((q) => q.id === id))
    .filter(Boolean);
}

/**
 * The order to re-ask questions in, when several are near the gate.
 *
 * Highest weight first, and within a weight, the graph order. The
 * point is that re-asking is expensive, so re-ask the question whose
 * answer is most likely to change the verdict.
 */
export function isolationOrder(graph, questionIds) {
  const byId = new Map(graph.questions.map((q) => [q.id, q]));
  return questionIds
    .map((id, i) => ({ id, weight: byId.get(id)?.weight ?? 0, i }))
    .sort((a, b) => (b.weight - a.weight) || (a.i - b.i))
    .map((x) => x.id);
}

/**
 * The blast radius of a question: if it is wrong, what inherits the
 * error.
 *
 * Two directions. Downward through the parts: a part's questions are
 * the evidence for it, and a part is the evidence for the decisions
 * that rest on it. Upward through the parts that depend on it.
 *
 * The weight travels with it, so a report can rank "if THIS question
 * is wrong, here is what you should look at first" rather than
 * presenting a flat list of dependents.
 */
export function impactOf(graph, questionId) {
  const q = graph.questions.find((x) => x.id === questionId);
  if (!q) fail(`no question ${questionId}`);

  // Downward: the decisions that require this question.
  const decisions = graph.decisions.filter((d) => (d.requires ?? []).includes(questionId))
    .map((d) => ({ id: d.id, part: d.part, weight: q.weight }));

  // Upward: the parts that (transitively) depend on this question's
  // part, with the number of hops so a direct dependent can be ranked
  // above a distant one.
  const dependents = [];
  const seen = new Set([q.part]);
  let frontier = [q.part];
  let hops = 1;
  while (frontier.length) {
    const next = [];
    for (const p of graph.parts) {
      if (seen.has(p.id)) continue;
      if ((p.dependsOn ?? []).some((d) => frontier.includes(d))) {
        seen.add(p.id);
        dependents.push({ id: p.id, hops, weight: q.weight / hops });
        next.push(p.id);
      }
    }
    frontier = next;
    hops++;
    if (hops > 64) break;               // defensive; assertAcyclic already ran
  }

  return { question: questionId, decisions, dependents };
}

/**
 * The weight mass of a part: the sum of the weights of the questions
 * that are evidence for it.
 *
 * This is a REPORTING number, not a confidence. It says "how much
 * evidence hangs on this part", which is not the same as "how good the
 * evidence is".
 */
export function partWeight(graph, partId) {
  return questionsOf(graph, partId)
    .filter((q) => q.weight > 0)
    .reduce((s, q) => s + q.weight, 0);
}

/**
 * A serialisable description of the graph, for the ledger's header.
 *
 * It carries the graph's STRUCTURE and the questions' TEXT and WEIGHT,
 * but NOT their scores -- the scores live in the observations, so a
 * ledger can be re-scored without losing its history.
 */
export function graphHeader(graph) {
  return {
    version: 1,
    parts: graph.parts.map((p) => ({ id: p.id, statement: p.statement, dependsOn: p.dependsOn ?? [] })),
    questions: graph.questions.map((q) => ({
      id: q.id, part: q.part, text: q.text, weight: q.weight,
      kind: q.kind, bindsTo: q.bindsTo, stateHash: stateHash(q.state),
    })),
    decisions: graph.decisions.map((d) => ({
      id: d.id, part: d.part, requires: d.requires ?? [],
      threshold: d.threshold, action: d.action,
      decides: d.decides ?? [], priors: d.priors ?? {},
    })),
  };
}

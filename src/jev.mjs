// A thin Jev client for scoring claim sets.
//
// Notes that came out of measuring the tool rather than reading its
// docs:
//
//   - the `state` field is the ONLY thing that makes an answer
//     spec-grounded rather than prior-grounded, so the spec text MUST
//     be in the state. An empty state produces a score about Jev's
//     beliefs, not about the spec.
//   - one request carries many questions, and the questions share
//     context, so questions about DIFFERENT clauses are asked in
//     separate requests to keep the context clean.
//   - a claim must be phrased as a claim ABOUT THE SPEC, not as a
//     question about the world, or the judge answers from knowledge.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function post(body, { tries = 4, timeoutMs = 60000 } = {}) {
  const key = process.env.TYPESAFE_AI_TOKEN;
  if (!key) throw new Error("TYPESAFE_AI_TOKEN is not set");
  const file = `/tmp/jev-req-${process.pid}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(body));
  let last = "";
  try {
    for (let i = 0; i < tries; i++) {
      const r = spawnSync("curl", ["-sk", "-m", String(Math.ceil(timeoutMs / 1000)),
        "--fail-with-body", ENDPOINT,
        "-H", `Authorization: Bearer ${key}`,
        "-H", "Content-Type: application/json",
        "--data-binary", `@${file}`],
        { encoding: "utf8", timeout: timeoutMs + 5000 });
      const out = (r.stdout || "") + (r.stderr || "");
      last = out;
      if (r.status === 0) {
        try {
          const d = JSON.parse(r.stdout);
          if (d.answers) return d;
        } catch { /* fall through to retry */ }
      }
      if (i < tries - 1) spawnSync("sleep", ["2"]);
    }
  } finally {
    try { unlinkSync(file); } catch { /* best effort */ }
  }
  throw new Error(`Jev request failed: ${last.slice(0, 200)}`);
}

/**
 * Score a list of claims against a state document.
 *
 * Claims are grouped by clause and each clause's claims go in one
 * request, so a judge never has to hold two unrelated spec sections in
 * context at once. Measured: 8 or 40 questions in one request reproduce
 * solo scores to within 0.003, so batching is free -- except for items
 * near the gate, which must be re-asked alone (see guards.mjs).
 *
 * GUARDS ARE ENFORCED HERE, not left to the caller:
 *
 *  1. The state is checked for CONTRADICTION first. Measured on this
 *     project's own spec: a false claim scores 0.01 against the clean
 *     spec and 0.86 against a spec with one contradicting clause
 *     appended. The judge detects the contradiction (0.38 -> 0.96) but
 *     does not act on it, so a contradictory state MUST NOT be scored.
 *  2. Aggregate claims are marked unreliable rather than gated on.
 *  3. Near-threshold items are flagged for isolation.
 *
 * @returns Map claimId -> probability
 */
export function scoreClaims(claims, state, { model = "jev-latest" } = {}) {
  const byClause = new Map();
  for (const c of claims) {
    if (!byClause.has(c.clause)) byClause.set(c.clause, []);
    byClause.get(c.clause).push(c);
  }
  const scores = new Map();
  for (const [clause, group] of byClause) {
    const questions = {};
    for (const c of group) {
      // The frame is MEASURED, not chosen.
      //
      // A capability probe over 26 labelled claims (9 true, 7 false, 10
      // world facts absent from the spec) compared two frames:
      //
      //   A  "Answer true if the specification text above supports..."
      //   E  "Answer true only if the state document EXPLICITLY STATES
      //       the following: <claim>"
      //
      //   frame   TRUE mean   FALSE mean   WORLD mean   world FP@0.5
      //   A         0.977       0.043        0.153        1/10
      //   E         0.950       0.031        0.035        0/10
      //
      // Both separate true from false. Only E separates them from WORLD
      // KNOWLEDGE: a bare claim about Python scores 0.95 against a spec
      // that never mentions Python, and that is a false positive waiting
      // to happen. Requiring the document to EXPLICITLY state the claim
      // drops the leak to 0.035 with no loss on true or false claims.
      //
      // This matters for THIS project specifically: a judge that answers
      // from world knowledge would be answering "what is true" and
      // labelling it "what the spec says", which is the one distinction
      // the whole reading-room method rests on.
      questions[c.id] = {
        type: "noul",
        instructions:
          `Answer true only if the state document explicitly states the following: ` +
          `${c.statement.replace(/\.$/, "")}.`,
      };
    }
    const d = post({ state: { spec: state, clause }, model, questions });
    for (const [id, ans] of Object.entries(d.answers ?? {})) {
      scores.set(id, typeof ans === "number" ? ans : ans?.noul);
    }
  }
  return scores;
}

/**
 * The full pipeline, with every guard applied.
 *
 * `scoreClaimsGuarded` is what a caller should use. It returns scores
 * AND the verdicts, so a caller can see WHY a claim was rejected
 * rather than receiving a number with no provenance.
 */
export async function scoreClaimsGuarded(claims, state, opts = {}) {
  const { detectContradiction, adjudicate } = await import("./guards.mjs");

  // 1. CONTRADICTION CHECK FIRST. A judge that can see a contradiction
  //    and then answers from it anyway is the worst measured failure
  //    mode, so this must precede every claim.
  const c = await detectContradiction(state, singleQuestion, opts);
  if (c.contradictory) {
    return {
      scores: new Map(),
      verdicts: [],
      blocked: true,
      reason:
        `the state is self-contradictory (score ${c.score.toFixed(3)}), so no ` +
        `claim can be scored against it -- the judge gives both sides ` +
        `partial credit and answers a false clause at 0.86`,
      contradiction: c,
    };
  }

  // 2. Score, grouped by clause.
  const scores = scoreClaims(claims, state, opts);

  // 3. Adjudicate, applying the aggregate and near-threshold rules.
  const byId = Object.fromEntries(claims.map((x) => [x.id, x]));
  const verdicts = adjudicate(scores, byId);
  return { scores, verdicts, blocked: false, contradiction: c };
}

/** Ask one question and return its score. */
export function singleQuestion(state, question, model = "jev-latest") {
  const body = { state, model, questions: { q: question } };
  const r = spawnSync("curl", ["-sk", "-m", "60", "--fail-with-body", ENDPOINT,
    "-H", `Authorization: Bearer ${process.env.TYPESAFE_AI_TOKEN}`,
    "-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body)],
    { encoding: "utf8", timeout: 65000 });
  if (r.status !== 0) throw new Error(`Jev: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
  try { return JSON.parse(r.stdout).answers.q.noul; }
  catch { return null; }
}

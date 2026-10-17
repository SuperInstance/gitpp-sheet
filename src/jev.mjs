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
 * context at once.
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
      questions[c.id] = {
        type: "noul",
        instructions:
          `${c.statement}\n\n` +
          `Answer true if the specification text above supports this statement. ` +
          `If the text does not settle it, do not guess.`,
      };
    }
    const d = post({ state: { spec: state, clause }, model, questions });
    for (const [id, ans] of Object.entries(d.answers ?? {})) {
      scores.set(id, typeof ans === "number" ? ans : ans?.noul);
    }
  }
  return scores;
}

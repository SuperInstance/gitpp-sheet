// A chain of thought as an EXECUTABLE SCRIPT.
//
// A big model is good at deciding WHAT TO DO. It is bad at deciding
// whether its own premises are supported, and it is expensive to ask
// again.
//
// So the split is:
//
//   THE BIG MODEL WRITES THE SCRIPT. The steps, the parts, the
//   questions, the edges. That is authoring, and it is what a big
//   model is for.
//
//   THE JUDGE CERTIFIES THE STEPS. Each step names the questions it
//   rests on; the judge answers them against a document; the guards
//   decide whether the answer may gate.
//
//   THE SCRIPT RUNS. A step that is not certified stops the script
//   there, with the reason, and the trace says which step failed and
//   why.
//
// The script is the GO/NO-GO. But unlike a gate, it is a SEQUENCE: the
// answer to "should we do this?" is a trace through the steps that
// were certified, not one number.
//
// TWO PROPERTIES THAT MATTER:
//
//   1. IT IS REPLAYABLE. Given a ledger, the script runs with NO judge
//      call at all. That is what makes the ledger worth keeping, and
//      it is what lets a small model -- or no model -- re-verify a
//      decision that a big model made.
//
//   2. IT STOPS AT THE FIRST FAILURE. A script that ran every step
//      and reported the worst would be a different thing: a script is
//      an ORDER of reasoning, and if step 2 fails, step 3 never
//      happened. The trace must say so.

import { observationOf, recordObservation } from "./ledger.mjs";
import { verdictFromLedger } from "./derive.mjs";
import { isolationOrder } from "./qgraph.mjs";
import { stateIsUsable, adjudicate } from "./guards.mjs";

/**
 * Run a script.
 *
 * @param script {id, steps: [{id, decision, observe?}]}
 * @param opts.jev  an optional judge. Without one, only what the
 *        ledger already holds can be used -- and a step that needs a
 *        missing observation FAILS, it does not guess.
 */
export function runScript(graph, ledger, script, opts = {}) {
  const { jev, record = false } = opts;
  let current = ledger;
  const trace = [];

  for (const step of script.steps ?? []) {
    const decision = graph.decisions.find((d) => d.id === step.decision);
    if (!decision) {
      trace.push({ step: step.id, status: "failed", reason: `no decision ${step.decision}` });
      return { id: script.id, status: "failed", stoppedAt: step.id, trace };
    }

    const required = decision.requires ?? [];

    // 1. OBSERVE what is missing, if we are allowed to.
    //
    // The judge is asked about a question's own state, and the guards
    // are applied to the RESULT. The state must be usable: an empty
    // state makes the judge answer from its own beliefs at ~0.6, and
    // that is indistinguishable from a confident reading.
    if (jev) {
      for (const qid of required) {
        if (observationOf(current, qid)) continue;
        const q = graph.questions.find((x) => x.id === qid);
        const usable = stateIsUsable(q?.state);
        if (!usable.usable) {
          trace.push({
            step: step.id, status: "failed",
            reason: `refusing to ask ${qid}: ${usable.reason}`,
          });
          return { id: script.id, status: "failed", stoppedAt: step.id, trace, ledger: current };
        }
        const score = jev(q.state, q.text);
        const [verdict] = adjudicate(new Map([[qid, score]]), { [qid]: { statement: q.text } });
        const rec = {
          q: qid, score, verdict: verdict?.status ?? null, reason: verdict?.reason ?? null,
          mode: "solo", state: q.state,
        };
        current = recordObservation(current, rec);
        if (record) trace.push({ step: step.id, status: "observed", question: qid, score, verdict: rec.verdict });
      }
    }

    // 2. JUDGE the step from what the ledger holds.
    const v = verdictFromLedger(current, required, decision.threshold ?? 0.5);

    if (!v.answerable) {
      // A step whose evidence is missing or unsafe stops the script.
      // It does not continue "cautiously", and it does not pass.
      const entry = {
        step: step.id, decision: decision.id, status: "failed",
        reason: v.reason,
        ...(v.needsIsolation ? { needsIsolation: v.needsIsolation } : {}),
      };
      trace.push(entry);
      return { id: script.id, status: "failed", stoppedAt: step.id, trace, ledger: current };
    }

    const entry = {
      step: step.id, decision: decision.id, status: v.pass ? "certified" : "failed",
      confidence: v.confidence, threshold: v.threshold, weakest: v.weakest,
      states: v.states,
    };
    trace.push(entry);
    if (!v.pass) {
      return { id: script.id, status: "failed", stoppedAt: step.id, trace, ledger: current };
    }
  }

  return { id: script.id, status: "certified", stoppedAt: null, trace, ledger: current };
}

/**
 * The questions a failed step would need re-asked, in the order to
 * re-ask them.
 *
 * Highest weight first: re-asking is expensive, so re-ask the question
 * whose answer is most likely to change the verdict.
 */
export function nextQuestions(graph, ledger, script, result) {
  const stopped = result?.stoppedAt;
  if (!stopped) return [];
  const step = (script.steps ?? []).find((s) => s.id === stopped);
  if (!step) return [];
  const decision = graph.decisions.find((d) => d.id === step.decision);
  if (!decision) return [];
  const near = (decision.requires ?? []).filter((qid) => {
    const o = observationOf(ledger, qid);
    return o && o.score >= 0.3 && o.score <= 0.7;
  });
  return isolationOrder(graph, near);
}

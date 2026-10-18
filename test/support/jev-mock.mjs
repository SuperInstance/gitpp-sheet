// A deterministic mock judge.
//
// The live judge is a network service: it costs money, it is
// occasionally 503, and its scores are not reproducible. The unit
// suite therefore needs a judge whose answers are a FUNCTION OF THE
// QUESTION, so that a test can assert on them.
//
// The mock is deliberately simple: a map from a substring of the
// question text to a score, and a default. It is not a model of the
// judge. It models the SHAPE of one: it reads a state, it returns a
// number, and it has no memory between calls.

export function makeMockJudge(answers = {}, fallback = 0.95) {
  const calls = [];
  const judge = (state, text) => {
    calls.push({ state, text });
    for (const [needle, score] of Object.entries(answers)) {
      if (String(text).includes(needle)) return score;
    }
    return fallback;
  };
  judge.calls = calls;
  return judge;
}

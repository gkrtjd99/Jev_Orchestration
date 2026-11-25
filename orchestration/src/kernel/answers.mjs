/** Shared validation of normalized judge answers (same shape as the Jev wire). */
import { assert, object } from '../util.mjs';

const unit = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const sum = values => values.reduce((s, x) => s + x, 0);

function validateScore(answer, question) {
  const levels = question.criteria;
  assert(Array.isArray(levels) && levels.length >= 2 && levels.length <= 10, 'INVALID_JEV_SCORE');
  assert(typeof answer.score === 'number' && Number.isFinite(answer.score)
    && answer.score >= 0 && answer.score <= levels.length - 1, 'INVALID_JEV_SCORE');
  assert(unit(answer.confidence) && object(answer.probabilities), 'INVALID_JEV_SCORE');
  const keys = levels.map((_, i) => String(i));
  const p = answer.probabilities;
  assert(Object.keys(p).length === keys.length && keys.every(k => Object.hasOwn(p, k) && unit(p[k])), 'INVALID_JEV_SCORE');
  assert(Math.abs(sum(Object.values(p)) - 1) < 0.001, 'INVALID_JEV_SCORE');
}

export function validateAnswers(response, questions) {
  assert(object(response) && typeof response.model === 'string' && object(response.answers), 'INVALID_JEV_ENVELOPE');
  for (const [id, q] of Object.entries(questions)) {
    const a = response.answers[id];
    assert(a?.type === q.type, 'INVALID_JEV_ANSWER_TYPE');
    if (q.type === 'noul') { assert(unit(a.noul), 'INVALID_JEV_NOUL'); continue; }
    if (q.type === 'score') { validateScore(a, q); continue; }
    assert(q.type === 'choice' && unit(a.confidence) && object(a.probabilities), 'INVALID_JEV_CHOICE');
    const keys = Object.keys(q.criteria);
    assert(keys.includes(a.choice), 'UNKNOWN_JEV_CHOICE');
    assert(Object.keys(a.probabilities).length === keys.length
      && keys.every(k => Object.hasOwn(a.probabilities, k) && unit(a.probabilities[k])), 'INVALID_JEV_PROBABILITIES');
    assert(Math.abs(sum(Object.values(a.probabilities)) - 1) < 0.001, 'INVALID_JEV_DISTRIBUTION');
    assert(a.probabilities[a.choice] >= Math.max(...Object.values(a.probabilities)) - 1e-8, 'CHOICE_DISTRIBUTION_MISMATCH');
  }
  return response;
}

/** Confidence in 0..1 for one normalized answer; a noul at 0.5 is maximally uncertain. */
export function answerConfidence(answer) {
  if (answer?.type === 'noul') return Math.abs(2 * answer.noul - 1);
  if (answer?.type === 'choice' || answer?.type === 'score') return answer.confidence;
  return 0;
}

export function minConfidence(answers) {
  const values = Object.values(answers ?? {}).map(answerConfidence);
  return values.length ? Math.min(...values) : null;
}

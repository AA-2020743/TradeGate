import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdictBrief, summarizeStances } from './verdictBrief.js';
import { buildVerdict } from './verdict.js';

const signal = (key, name, score, weight) => ({ key, name, score, weight });

test('the brief carries each section\'s own verdict, in the same words as its page', () => {
  const gold = buildVerdict({ title: 'Gold conditions', subject: 'gold', signals: [signal('a', 'Gold technicals', 80, 0.4), signal('b', 'Dollar', 70, 0.3), signal('c', 'Global liquidity impulse', 60, 0.3)] });
  const brief = buildVerdictBrief({
    verdicts: { metals: gold },
    records: { records: { metals: { status: 'calculated', summary: { plain: { grade: 'Risk gauge', tone: 'neutral', sentence: 'Use it to gauge risk.' } } } } },
  });
  const entry = brief.entries.find((item) => item.key === 'metals');
  assert.equal(entry.stance, 'tailwind');
  assert.equal(entry.bottomLine, gold.bottomLine);
  assert.equal(entry.score, gold.score);
  assert.equal(entry.page, 'Metals');
  assert.equal(entry.record.grade, 'Risk gauge');
  // The other four did not report, and say why rather than vanishing.
  assert.equal(brief.status, 'partial');
  const macro = brief.entries.find((item) => item.key === 'macro');
  assert.equal(macro.status, 'unavailable');
  assert.match(macro.reason, /Macro verdict did not publish/);
});

test('a section whose loader failed says why', () => {
  const brief = buildVerdictBrief({ failures: { crypto: 'bitcoin did not answer within 30s.' } });
  assert.equal(brief.status, 'unavailable');
  assert.equal(brief.summary, null);
  assert.equal(brief.entries.find((item) => item.key === 'crypto').reason, 'bitcoin did not answer within 30s.');
});

test('one sentence sums up every asset that reported', () => {
  assert.equal(
    summarizeStances([
      { subject: 'gold', stance: 'tailwind' },
      { subject: 'bitcoin', stance: 'tailwind' },
      { subject: 'the dollar', stance: 'headwind' },
      { subject: 'risk assets', stance: 'mixed' },
      { subject: 'the S&P 500', stance: 'mixed' },
    ]),
    'Conditions favour gold and bitcoin, lean against the dollar, and are mixed for risk assets and the S&P 500.',
  );
  assert.equal(summarizeStances([{ subject: 'gold', stance: 'mixed' }]), 'Conditions are mixed for gold.');
  assert.equal(summarizeStances([{ subject: 'gold', stance: 'tailwind' }, { subject: 'bitcoin', stance: 'headwind' }]), 'Conditions favour gold and lean against bitcoin.');
  assert.equal(summarizeStances([]), null);
});

test('a verdict without a stance (an older payload) is not presented as an answer', () => {
  const brief = buildVerdictBrief({ verdicts: { fx: { status: 'calculated', score: 60, headline: 'Rangebound dollar.' } } });
  assert.equal(brief.entries.find((item) => item.key === 'fx').status, 'unavailable');
});

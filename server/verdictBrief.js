/**
 * Every section's verdict on one card, for the Overview.
 *
 * An investor opening the platform had to visit five pages to learn what it
 * thought about risk assets, stocks, gold, the dollar and bitcoin, and each
 * page answered in its own vocabulary. The brief puts the five answers side by
 * side in the same words: a stance, the one-sentence bottom line, how sure the
 * model is, and whether its calls have held up. Nothing is recomputed here:
 * each entry is the section's own verdict, so the card and the page it links
 * to cannot disagree.
 */

export const BRIEF_SECTIONS = [
  { key: 'macro', label: 'Risk assets', subject: 'risk assets', page: 'Macro', recordKey: null },
  { key: 'equities', label: 'S&P 500', subject: 'the S&P 500', page: 'Equities', recordKey: null },
  { key: 'metals', label: 'Gold', subject: 'gold', page: 'Metals', recordKey: 'metals' },
  { key: 'fx', label: 'US dollar', subject: 'the dollar', page: 'Forex', recordKey: 'fx' },
  { key: 'crypto', label: 'Bitcoin', subject: 'bitcoin', page: 'Crypto', recordKey: 'crypto' },
];

const STANCES = ['tailwind', 'mixed', 'headwind'];

/** "a", "a and b", "a, b and c". */
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * One sentence across every asset that reported:
 * "Conditions favour gold and bitcoin, lean against the dollar, and are mixed
 * for risk assets and the S&P 500."
 */
export function summarizeStances(entries) {
  const by = Object.fromEntries(STANCES.map((stance) => [stance, entries.filter((entry) => entry.stance === stance).map((entry) => entry.subject)]));
  const clauses = [
    by.tailwind.length ? `favour ${joinNames(by.tailwind)}` : null,
    by.headwind.length ? `lean against ${joinNames(by.headwind)}` : null,
    by.mixed.length ? `are mixed for ${joinNames(by.mixed)}` : null,
  ].filter(Boolean);
  if (!clauses.length) return null;
  const sentence = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')}${clauses.length > 2 ? ',' : ''} and ${clauses.at(-1)}`;
  return `Conditions ${sentence}.`;
}

/**
 * @param verdicts  section key -> that section's verdict object
 * @param failures  section key -> why its loader failed
 * @param records   the /api/analytics/verdict-records payload, or null
 */
export function buildVerdictBrief({ verdicts = {}, failures = {}, records = null, now = new Date() } = {}) {
  const entries = BRIEF_SECTIONS.map((section) => {
    const verdict = verdicts[section.key] ?? null;
    const recordEntry = section.recordKey ? records?.records?.[section.recordKey] : null;
    const record = recordEntry?.status === 'calculated' ? recordEntry.summary?.plain ?? null : null;
    const base = { key: section.key, label: section.label, subject: section.subject, page: section.page, record };
    if (!verdict || verdict.status === 'unavailable' || !STANCES.includes(verdict.stance)) {
      return {
        ...base,
        status: 'unavailable',
        stance: null,
        score: null,
        bottomLine: null,
        reason: failures[section.key] ?? verdict?.reason ?? `The ${section.page} verdict did not publish.`,
      };
    }
    return {
      ...base,
      status: verdict.status,
      stance: verdict.stance,
      score: verdict.score,
      call: verdict.call ?? null,
      // Gold and the dollar are shown as conditions, not calls, because their
      // replayed calls did not rank what followed. The card says so too.
      presentation: verdict.presentation ?? 'call',
      bottomLine: verdict.bottomLine,
      confidence: verdict.confidence ?? null,
      confidenceWhy: verdict.confidenceWhy ?? null,
      missing: (verdict.missing ?? []).map((entry) => entry.name),
    };
  });
  const reported = entries.filter((entry) => entry.stance);
  return {
    version: 'verdict-brief-v1',
    status: reported.length === entries.length ? 'calculated' : reported.length ? 'partial' : 'unavailable',
    asOf: now.toISOString(),
    summary: summarizeStances(reported),
    entries,
  };
}

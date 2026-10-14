// Preference-guided adaptive search. This learns which proposed parameter
// changes users prefer, NOT ground-truth pixel labels or a neural network.
const ADJUSTMENTS = Object.freeze([
  ['sensitivity', -5], ['sensitivity', 5], ['sensitivity', -12], ['sensitivity', 12],
  ['darkWeight', -15], ['darkWeight', 15], ['ridgeWeight', -15], ['ridgeWeight', 15],
  ['colorWeight', -15], ['colorWeight', 15], ['dendriteWeight', -15], ['dendriteWeight', 15],
  ['negativeEvidenceWeight', -15], ['negativeEvidenceWeight', 15],
  ['minComponent', -8], ['minComponent', 8], ['centerlineNms', 'toggle'],
]);
const LIMITS = { sensitivity: [1,100], darkWeight: [0,100], ridgeWeight: [0,100],
  colorWeight: [0,100], dendriteWeight: [0,100], negativeEvidenceWeight: [0,100],
  minComponent: [1,300] };
export function changeSetting(base, action) {
  if (!action || !ADJUSTMENTS.some(candidate => candidate[0] === action[0] && candidate[1] === action[1])) return null;
  const [key, step] = action;
  const result = { ...base };
  if (step === 'toggle') result[key] = !Boolean(result[key]);
  else {
    const old = Number(base[key]);
    if (!Number.isFinite(old)) return null;
    result[key] = Math.max(LIMITS[key][0],Math.min(LIMITS[key][1],Math.round(old + step)));
  }
  return result[key] === base[key] ? null : result;
}
export function comparisonKey(config) {
  return ['sensitivity','darkWeight','ridgeWeight','colorWeight','dendriteWeight',
    'negativeEvidenceWeight','minComponent','centerlineNms','scoreMode'].map(k => String(config[k] ?? '')).join('|');
}
function scoreArm(action, votes, round) {
  const key = action.join(':');
  let rewards=0, uses=0;
  for (const vote of votes) {
    if (vote.actionKey !== key) continue;
    uses++;
    if (vote.winner === 'b') rewards+=1;
    else if (vote.winner === 'a') rewards+=0;
    else if (vote.winner === 'neither') rewards+=0.15;
    else rewards+=0.4;
  }
  // UCB1-style exploration prevents the search from repeating only sensitivity.
  return (rewards + 1) / (uses + 2) + 0.8 * Math.sqrt(Math.log(round + 2)/(uses + 1));
}
export function proposePreferenceCandidate(champion, votes=[], options={}) {
  const known = Array.isArray(votes) ? votes : [];
  const round = Number(options.round ?? known.length);
  const skipKeys = new Set(options.skipKeys ?? []);
  const candidates = ADJUSTMENTS.map(action => {
    const parameters = changeSetting(champion, action);
    if (!parameters || skipKeys.has(comparisonKey(parameters))) return null;
    const repeat = known.filter(v => v.aKey === comparisonKey(champion) &&
      v.bKey === comparisonKey(parameters) && v.winner !== 'uncertain').length;
    return { parameters, action, actionKey:action.join(':'), repeat,
      score: scoreArm(action,known,round) - repeat*0.25 };
  }).filter(Boolean).sort((a,b)=>b.score-a.score || a.repeat-b.repeat ||
    a.actionKey.localeCompare(b.actionKey));
  return candidates[0] ?? null;
}
export function advancePreference(champion, challenger, winner) {
  if (!['a','b','neither','uncertain'].includes(winner)) throw new Error('unknown preference');
  // 'neither' and 'uncertain' do not imply that B is better; retain champion.
  return winner === 'b' ? { ...challenger } : { ...champion };
}
export function buildPreferenceVote({ champion, challenger, winner, proposal, fingerprint, roi, round }) {
  return {
    schema:'graintracer-preference-v2',
    createdAt:new Date().toISOString(), imageFingerprint:fingerprint,
    coordinateSystem:'analysis-preview', roi:{...roi}, winner,
    aSettings:{...champion}, bSettings:{...challenger},
    aKey:comparisonKey(champion), bKey:comparisonKey(challenger),
    actionKey:proposal?.actionKey ?? null, round,
  };
}

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
    const manual=Number(vote.manualEvidence?.difference??0);
    const labelWeight=vote.manualEvidence?.labeled>=8 ? Math.max(-.3,Math.min(.3,manual)) : 0;
    // Explicit partial labels provide weak additional evidence, but the
    // preference vote remains primary and unknown pixels are not negatives.
    if (vote.winner === 'b') rewards+=Math.max(0,Math.min(1,1+labelWeight));
    else if (vote.winner === 'a') rewards+=Math.max(0,labelWeight);
    else if (vote.winner === 'neither') rewards+=Math.max(0,.15+labelWeight);
    else rewards+=Math.max(0,.4+labelWeight);
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
// Only scalar, reproducible settings belong in JSON votes. Masks and classifier
// tensors from currentBoundaryOptions must NEVER be copied into each review.
export function preferenceParameterSnapshot(configuration) {
  const keys = ['sensitivity','darkWeight','ridgeWeight','colorWeight',
    'dendriteWeight','negativeEvidenceWeight','minComponent','centerlineNms',
    'scoreMode','edgeFrameGuard'];
  return Object.fromEntries(keys.map(key => [key, configuration?.[key] ?? null]));
}
export function recoverPreferenceChampion(liveSettings, votes, fingerprint, featureOptions, algorithmVersion) {
  const matched=(votes??[]).filter(v=>v?.schema==='graintracer-preference-v2' &&
    v.eligibleForLearning!==false && v.imageFingerprint===fingerprint &&
    v.algorithmVersion===algorithmVersion &&
    JSON.stringify(v.featureOptions??{})===JSON.stringify(featureOptions??{}));
  if (!matched.length) return { ...liveSettings };
  const last=matched[matched.length-1];
  // v0.9 stores the post-consensus champion explicitly. Do not restore a
  // candidate that merely won one ROI but was never promoted globally.
  const selected=last.championAfter ??
    (last.winner==='b'?last.bSettings:last.aSettings);
  const result={...liveSettings};
  for (const key of Object.keys(preferenceParameterSnapshot(liveSettings))) {
    const value=selected?.[key];
    if (typeof value==='number' && Number.isFinite(value)) result[key]=value;
    else if (key==='centerlineNms' && typeof value==='boolean') result[key]=value;
  }
  return result;
}

export function buildPreferenceVote({ champion, challenger, winner, proposal, fingerprint, roi, round }) {
  return {
    schema:'graintracer-preference-v2',
    createdAt:new Date().toISOString(), imageFingerprint:fingerprint,
    coordinateSystem:'analysis-preview', roi:{...roi}, winner,
    aSettings:preferenceParameterSnapshot(champion), bSettings:preferenceParameterSnapshot(challenger),
    aKey:comparisonKey(champion), bKey:comparisonKey(challenger),
    actionKey:proposal?.actionKey ?? null, round,
  };
}

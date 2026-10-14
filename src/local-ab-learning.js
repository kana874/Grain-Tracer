import { comparisonKey, preferenceParameterSnapshot } from './preference-optimizer.js';
function roiCell(roi,cell=128) {
  const cx=Math.floor((roi.x+roi.width/2)/cell);
  const cy=Math.floor((roi.y+roi.height/2)/cell);
  return cx+','+cy;
}
export function aggregatePreferenceAcrossRois(champion,challenger,votes=[],options={}){
  const aKey=comparisonKey(champion),bKey=comparisonKey(challenger);
  const evidence=new Map();
  for(const vote of votes){
    if(vote?.eligibleForLearning===false || vote?.imageFingerprint!==options.fingerprint ||
      vote?.algorithmVersion!==options.algorithmVersion ||
      JSON.stringify(vote.featureOptions??{})!==JSON.stringify(options.featureOptions??{}) ||
      vote.aKey!==aKey || vote.bKey!==bKey || !vote.roi)continue;
    // At most one vote per spatial cell; the most recent decision supersedes
    // duplicate repeats and prevents one small ROI dominating global search.
    evidence.set(roiCell(vote.roi,Math.max(64,options.cellSize??128)),vote);
  }
  let a=0,b=0,neither=0,uncertain=0;
  for(const v of evidence.values()){
    if(v.winner==='a')a++;
    else if(v.winner==='b')b++;
    else if(v.winner==='neither')neither++;
    else uncertain++;
  }
  const threshold=Math.max(2,Number(options.minDistinctRois??2));
  const decided=b>=threshold&&b>=a+1?'b':a>=threshold&&a>=b+1?'a':null;
  return {winner:decided,distinctRois:evidence.size,a,b,neither,uncertain,
    sufficient:decided!==null,requiredDistinctRois:threshold};
}
export function evaluateManualLabelEvidence(maskA,maskB,width,height,roi,positive,negative,options={}){
  const excluded=options.exclusionMask;
  let labeled=0, aScore=0,bScore=0;
  // Score only explicitly labelled pixels. Unknown pixels must never be
  // silently classified as background.
  for(let y=roi.y;y<roi.y+roi.height;y++){
    for(let x=roi.x;x<roi.x+roi.width;x++){
      const p=y*width+x;
      if(excluded?.[p])continue;
      const pos=!!positive?.[p],neg=!!negative?.[p];
      if(!pos&&!neg)continue;
      labeled++;
      aScore+=pos?(maskA[p]?1:0):(maskA[p]?-1:0);
      bScore+=pos?(maskB[p]?1:0):(maskB[p]?-1:0);
    }
  }
  return {labeled,scoreA:labeled?aScore/labeled:0,scoreB:labeled?bScore/labeled:0,
    difference:labeled?(bScore-aScore)/labeled:0, unknownExcluded:true};
}
export function summarizePreferenceLearning(votes=[],adoptions=[]){
  const valid=votes.filter(v=>v.schema==='graintracer-preference-v2');
  const roiKeys=new Set(valid.map(v=>roiCell(v.roi??{x:0,y:0,width:1,height:1})));
  return {votes:valid.length,distinctRois:roiKeys.size,
    adopted:adoptions.filter(x=>x.accepted).length,
    rejected:adoptions.filter(x=>!x.accepted).length};
}

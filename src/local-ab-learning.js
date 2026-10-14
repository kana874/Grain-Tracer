import { comparisonKey, preferenceParameterSnapshot } from './preference-optimizer.js';
function roiCell(roi,cell=128) {
  const cx=Math.floor((roi.x+roi.width/2)/cell);
  const cy=Math.floor((roi.y+roi.height/2)/cell);
  return cx+','+cy;
}
export function aggregatePreferenceAcrossRois(champion,challenger,votes=[],options={}){
  const aKey=comparisonKey(champion),bKey=comparisonKey(challenger);
  const evidence=[];
  for(const vote of votes){
    if(vote?.eligibleForLearning===false || vote?.imageFingerprint!==options.fingerprint ||
      vote?.algorithmVersion!==options.algorithmVersion ||
      JSON.stringify(vote.featureOptions??{})!==JSON.stringify(options.featureOptions??{}) ||
      vote.aKey!==aKey || vote.bKey!==bKey || !vote.roi)continue;
    // Two heavily overlapping ROIs do not count as independent evidence.
    // The most recent judgment replaces older decisions in the same patch.
    const overlap=(rect1,rect2)=>{
      const x=Math.max(0,Math.min(rect1.x+rect1.width,rect2.x+rect2.width)-
        Math.max(rect1.x,rect2.x));
      const y=Math.max(0,Math.min(rect1.y+rect1.height,rect2.y+rect2.height)-
        Math.max(rect1.y,rect2.y));
      return x*y/Math.max(1,Math.min(
        rect1.width*rect1.height,rect2.width*rect2.height));
    };
    const existing=evidence.findIndex(v=>overlap(v.roi,vote.roi)>.25);
    if(existing>=0)evidence[existing]=vote;
    else evidence.push(vote);
  }
  let a=0,b=0,neither=0,uncertain=0;
  for(const v of evidence){
    if(v.winner==='a')a++;
    else if(v.winner==='b')b++;
    else if(v.winner==='neither')neither++;
    else uncertain++;
  }
  const threshold=Math.max(2,Number(options.minDistinctRois??2));
  const decided=b>=threshold&&b>=a+1?'b':a>=threshold&&a>=b+1?'a':null;
  return {winner:decided,distinctRois:evidence.length,a,b,neither,uncertain,
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

export function summarizeValidationTrend(adoptions=[]){
  const last=adoptions.at(-1);
  if(!last?.before || !last?.after)return {status:'未検証',delta:null,f1:null,
    description:last?.reason??'確認済みValidation ROIが必要'};
  const before=Number(last.before.f1),after=Number(last.after.f1);
  if(!Number.isFinite(before)||!Number.isFinite(after))
    return {status:'未検証',delta:null,f1:null,description:'Validation F1不明'};
  const delta=after-before;
  const status=delta>.005?'改善':delta<-.005?'悪化':'停滞';
  return {status,delta,f1:after,description:
    'Validation F1 '+(before*100).toFixed(2)+'% → '+(after*100).toFixed(2)+
    '% ('+(delta>=0?'+':'')+(delta*100).toFixed(2)+'pt)'+
    (last.accepted?' 採用済み':' 未採用')};
}

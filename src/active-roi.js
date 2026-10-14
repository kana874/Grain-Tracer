import { positionLocalRoi } from './local-ab.js';
const intersect = (a,b) => Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))
  * Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
function toBounds(rect) {
  if (Number.isFinite(rect?.x)) return rect;
  const x=Math.min(rect.x0,rect.x1),y=Math.min(rect.y0,rect.y1);
  return {x,y,width:Math.abs(rect.x1-rect.x0)+1,height:Math.abs(rect.y1-rect.y0)+1};
}
function protectedArea(candidate, rects) {
  return (rects??[]).some(rect=>intersect(candidate,toBounds(rect))>0);
}
export function recommendDisagreementRoi(maskA,maskB,width,height,size,options={}) {
  if(!maskA||!maskB||maskA.length!==width*height||maskB.length!==maskA.length)throw new Error('invalid candidates');
  const histories=options.history??[], forbidden=options.protectedRois??[];
  const exclusionMask=options.exclusionMask??null;
  const side=Math.max(16,Math.round(size));
  const roiSize=Math.min(width,side),roiHeight=Math.min(height,side);
  const stride=Math.max(24,Math.floor(side/2));
  const cx=[...new Set([0,Math.floor(width/2),width-1,
    ...Array.from({length:Math.ceil(width/stride)+1},(_,i)=>Math.min(width-1,i*stride))])];
  const cy=[...new Set([0,Math.floor(height/2),height-1,
    ...Array.from({length:Math.ceil(height/stride)+1},(_,i)=>Math.min(height-1,i*stride))])];
  let best=null;
  const visited=new Set();
  for(const y of cy)for(const x of cx){
    const roi=positionLocalRoi(width,height,side,x,y);
    const key=roi.x+','+roi.y;
    if(visited.has(key)){continue;}
    visited.add(key);
    if(protectedArea(roi,forbidden))continue;
    let different=0,known=0,unlabeled=0,active=0;
    // 2-pixel sampling is faster but deterministic for every candidate.
    for(let yy=roi.y;yy<roi.y+roi.height;yy+=2){
      for(let xx=roi.x;xx<roi.x+roi.width;xx+=2){
        const p=yy*width+xx;
        if(exclusionMask?.[p])continue;
        known++;
        const a=!!maskA[p],b=!!maskB[p];
        if(a!==b)different++;
        if(a||b)active++;
        if(!options.labelMask?.[p] && !options.negativeLabelMask?.[p])unlabeled++;
      }
    }
    if(known===0)continue;
    const disagreement=different/known;
    const novelty=unlabeled/known;
    const touchesEdge=roi.x===0||roi.y===0||roi.x+roi.width===width||roi.y+roi.height===height;
    const repeat=histories.reduce((sum,v)=>sum+(v.roi&&intersect(roi,toBounds(v.roi))/
      Math.max(1,roi.width*roi.height) > 0.40 ? 1 : 0),0);
    // Prefer useful uncertainty/disagreement, not empty/constant regions.
    const content=active/known;
    const score=disagreement*5 + novelty*.6 + Math.min(0.3,content)*.5
      + (touchesEdge?.3:0) - repeat*0.65;
    const candidate={roi,score,disagreement,novelty,touchesEdge,repeat};
    if(!best||score>best.score+1e-12||
      (Math.abs(score-best.score)<=1e-12&&(roi.y<best.roi.y||
        (roi.y===best.roi.y&&roi.x<best.roi.x))))best=candidate;
  }
  return best;
}

function approximateCandidateScore(features,p,settings) {
  const channels=[['dark','darkWeight'],['ridge','ridgeWeight'],
    ['color','colorWeight'],['dendrite','dendriteWeight']];
  let sum=0,weight=0;
  for(const [name,key] of channels){
    const w=Math.max(0,Number(settings[key]??0));
    sum+=(features[name]?.[p]??0)*w/255;
    weight+=w;
  }
  let score=weight?sum/weight:0;
  if(settings.scoreMode==='evidence')
    score-=((features.dendriteLinePenalty?.[p]??0)/255)*
      Math.max(0,Number(settings.negativeEvidenceWeight??35))/100;
  return score;
}
// Fast full-preview recommendation. Uses only sampled immutable feature
// evidence and current masks: it never performs full-image segmentation.
export function recommendFeatureRoi(features,champion,challenger,size,options={}) {
  const width=features.width,height=features.height;
  const cellStep=Math.max(16,Math.floor(size/2));
  const forbidden=options.protectedRois??[],history=options.history??[];
  const visited=new Set();
  let best=null;
  for(let y=0;y<height;y+=cellStep){
    for(let x=0;x<width;x+=cellStep){
      const roi=positionLocalRoi(width,height,size,x+cellStep/2,y+cellStep/2);
      const key=roi.x+','+roi.y;
      if(visited.has(key))continue;
      visited.add(key);
      if(protectedArea(roi,forbidden))continue;
      let disagreement=0,unknown=0,valid=0,texture=0;
      for(let yy=roi.y;yy<roi.y+roi.height;yy+=4){
        for(let xx=roi.x;xx<roi.x+roi.width;xx+=4){
          const p=yy*width+xx;
          if(options.exclusionMask?.[p])continue;
          valid++;
          const a=approximateCandidateScore(features,p,champion);
          const b=approximateCandidateScore(features,p,challenger);
          const tA=0.76-Math.max(1,Number(champion.sensitivity??62))/100*.55;
          const tB=0.76-Math.max(1,Number(challenger.sensitivity??62))/100*.55;
          if((a>=tA)!==(b>=tB))disagreement++;
          if(!options.labelMask?.[p]&&!options.negativeLabelMask?.[p])unknown++;
          texture+=(features.ridge?.[p]??0)/255;
        }
      }
      if(!valid)continue;
      const repeat=history.filter(v=>v.roi&&intersect(roi,toBounds(v.roi))/
        (roi.width*roi.height)>.40).length;
      const edge=roi.x===0||roi.y===0||roi.x+roi.width===width||roi.y+roi.height===height;
      const score=disagreement/valid*6+unknown/valid*.4+texture/valid*.15+
        (edge?.20:0)-Math.min(8,repeat)*.32;
      const item={roi,score,disagreement:disagreement/valid,novelty:unknown/valid,
        touchesEdge:edge,repeat,approximate:true};
      if(!best||item.score>best.score+1e-12)best=item;
    }
  }
  return best;
}

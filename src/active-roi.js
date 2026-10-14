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

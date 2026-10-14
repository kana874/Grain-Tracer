// Dedicated Validation ROI creation: only consciously reviewed and user-attested
// regions may become a held-out evaluation set.
export function roiBounds(rect) {
  if (!rect) return null;
  const x0 = Math.min(rect.x0 ?? rect.x,rect.x1 ?? ((rect.x??0)+(rect.width??1)-1));
  const y0 = Math.min(rect.y0 ?? rect.y,rect.y1 ?? ((rect.y??0)+(rect.height??1)-1));
  const x1 = Math.max(rect.x0 ?? rect.x,rect.x1 ?? ((rect.x??0)+(rect.width??1)-1));
  const y1 = Math.max(rect.y0 ?? rect.y,rect.y1 ?? ((rect.y??0)+(rect.height??1)-1));
  return {x0,y0,x1,y1};
}
export function roiOverlapPixels(a,b) {
  const r=roiBounds(a),s=roiBounds(b);
  if(!r||!s)return 0;
  return Math.max(0,Math.min(r.x1,s.x1)-Math.max(r.x0,s.x0)+1)*
    Math.max(0,Math.min(r.y1,s.y1)-Math.max(r.y0,s.y0)+1);
}
export function validationRoiConflicts(rect,existingRois=[],abReviews=[],ignoreIndex=-1,feedbackReviews=[]) {
  const overlap=existingRois.findIndex((prior,i)=>i!==ignoreIndex && roiOverlapPixels(rect,prior)>0);
  if(overlap>=0)return {ok:false,reason:'既存の完全評価ROI #'+(overlap+1)+' と重なっています。別の領域を選択してください。'};
  const vote=abReviews.find(v=>v?.eligibleForLearning!==false&&v?.roi&&roiOverlapPixels(rect,v.roi)>0);
  if(vote)return {ok:false,reason:'以前のA/B学習領域と重なっています。未使用の場所を指定してください。'};
  const labeled=feedbackReviews.find(v=>{
    const marked=v?.roi ?? (Number.isFinite(v?.x)&&Number.isFinite(v?.y)
      ? {x:v.x,y:v.y,width:1,height:1}:null);
    return marked&&roiOverlapPixels(rect,marked)>0;
  });
  if(labeled)return {ok:false,reason:'以前の手動学習ラベルを含む領域です。独立した別のROIを選んでください。'};
  return {ok:true,reason:null};
}
export function referencePixelsInRect(centerline,width,height,rect,excluded=null) {
  const {x0,y0,x1,y1}=roiBounds(rect);
  let count=0;
  for(let y=Math.max(0,Math.ceil(y0));y<=Math.min(height-1,Math.floor(y1));y++){
    for(let x=Math.max(0,Math.ceil(x0));x<=Math.min(width-1,Math.floor(x1));x++){
      const p=y*width+x;
      if(centerline?.[p]&&!excluded?.[p])count++;
    }
  }
  return count;
}
export function canVerifyValidationRoi({
  rect,referenceCenterline,width,height,excluded,
  attested=false,existingRois=[],abReviews=[],ignoreIndex=-1,
  minReferencePixels=20,feedbackReviews=[],
}){
  if(!rect||rect.verified!==false||rect.evaluationRole!=='validation')
    return {ok:false,reason:'未完了のValidation ROIを選択してください。'};
  const conflicts=validationRoiConflicts(rect,existingRois,abReviews,ignoreIndex,feedbackReviews);
  if(!conflicts.ok)return conflicts;
  const pixels=referencePixelsInRect(referenceCenterline,width,height,rect,excluded);
  if(pixels<minReferencePixels)return {ok:false,reason:'確認済み正解線が不足しています（'+pixels+' / '+minReferencePixels+' px）。'};
  if(!attested)return {ok:false,reason:'領域内の全粒界・誤検出・欠落を確認したチェックが必要です。'};
  return {ok:true,referencePixels:pixels,reason:null};
}

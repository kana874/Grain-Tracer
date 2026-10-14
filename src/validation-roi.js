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


/**
 * Build a purely visual map from stored per-image history. Unrecorded earlier
 * training cannot be reconstructed, so clear space means "no saved history",
 * not a guarantee that this image has never been inspected.
 */
export function validationUsageAreas(width,height,existingRois=[],abReviews=[],feedbackReviews=[],exclusionRects=[],fingerprint=null) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1) return [];
  const all=[];
  const add=(geometry,kind)=>{
    if(!geometry)return;
    const bounds=roiBounds(geometry);
    if(!bounds || ![bounds.x0,bounds.y0,bounds.x1,bounds.y1].every(Number.isFinite))return;
    const x0=Math.max(0,Math.min(width-1,Math.floor(bounds.x0)));
    const y0=Math.max(0,Math.min(height-1,Math.floor(bounds.y0)));
    const x1=Math.max(0,Math.min(width-1,Math.ceil(bounds.x1)));
    const y1=Math.max(0,Math.min(height-1,Math.ceil(bounds.y1)));
    if(x0<=x1&&y0<=y1)all.push({x0,y0,x1,y1,kind});
  };
  for(const roi of existingRois) add(roi,'existing');
  for(const vote of abReviews) {
    if(vote?.eligibleForLearning===false)continue;
    if(fingerprint && vote?.imageFingerprint && vote.imageFingerprint!==fingerprint)continue;
    add(vote?.roi,'ab');
  }
  for(const review of feedbackReviews){
    if(fingerprint && review?.imageFingerprint && review.imageFingerprint!==fingerprint)continue;
    const geo=review?.roi ??
      (Number.isFinite(review?.x)&&Number.isFinite(review?.y)
        ? {x:review.x-5,y:review.y-5,width:11,height:11}:null);
    add(geo,'manual');
  }
  for(const rect of exclusionRects)add(rect,'excluded');
  return all;
}

/** Find a clear rectangle at the largest practicable size without re-running
 * image segmentation. The final candidate is also checked against the
 * production holdout guard, never only against the visualization rectangles.
 */
export function recommendUnusedValidationRoi({
  width,height,existingRois=[],abReviews=[],feedbackReviews=[],exclusionRects=[],
  fingerprint=null,sizes=[256,192,128,96],
}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)return null;
  const used=validationUsageAreas(width,height,existingRois,abReviews,feedbackReviews,exclusionRects,fingerprint);
  const sizesToTry=[...new Set(sizes.map(s=>Math.max(1,Math.floor(s))))].sort((a,b)=>b-a);
  const overlaps=(r,s)=>roiOverlapPixels(r,s)>0;
  const gridPositions=(length,side)=>{
    const limit=length-side,step=Math.max(12,Math.floor(side/4));
    if(limit<0)return [];
    const positions=[0,limit,Math.floor(limit/2)];
    for(let start=0;start<=limit;start+=step)positions.push(start);
    return [...new Set(positions)].sort((a,b)=>a-b);
  };
  for(const size of sizesToTry){
    if(size>width||size>height)continue;
    let best=null, bestScore=-Infinity;
    const xs=gridPositions(width,size),ys=gridPositions(height,size);
    for(const y of ys)for(const x of xs){
      const rect={x0:x,y0:y,x1:x+size-1,y1:y+size-1};
      if(used.some(u=>overlaps(u,rect)))continue;
      if(!validationRoiConflicts(rect,existingRois,abReviews,-1,feedbackReviews).ok)continue;
      // Maximize distance to previously used regions, without always
      // preferring the very corner of a large micrograph.
      let distance=Infinity;
      const cx=x+size/2,cy=y+size/2;
      for(const usedRect of used){
        const ux=Math.max(usedRect.x0,Math.min(cx,usedRect.x1));
        const uy=Math.max(usedRect.y0,Math.min(cy,usedRect.y1));
        distance=Math.min(distance,Math.hypot(cx-ux,cy-uy));
      }
      if(!Number.isFinite(distance))distance=Math.min(width,height)/3;
      const edgeMargin=Math.min(x,y,width-x-size,height-y-size);
      const score=distance+Math.min(edgeMargin,100)*0.2;
      if(score>bestScore){bestScore=score;best=rect;}
    }
    if(best)return {...best,size,reason:'履歴に残っている学習領域・評価ROI・除外領域と重ならない位置'};
  }
  return null;
}

// Stroke-guided annotation: only pixels near the manually drawn path can be
// labelled. No BFS flood-fill, even when distinct grain lines touch.
export function rasterizeGuidedStroke(points, mask, width, height, options={}) {
  if (!Array.isArray(points) || !points.length || !Number.isInteger(width) || !Number.isInteger(height) ||
      width<1 || height<1 || mask?.length!==width*height) return [];
  const radius = Math.max(0,Math.min(3,Math.round(options.snapRadius??2)));
  const excluded=options.exclusionMask??null, roi=options.roi??null;
  const maxPixels=Math.max(1,Math.min(6000,Math.round(options.maxPixels??3000)));
  const seen=new Set(), output=[];
  function add(x,y) {
    if (x<0||y<0||x>=width||y>=height) return;
    if (roi && (x<roi.x||y<roi.y||x>=roi.x+roi.width||y>=roi.y+roi.height)) return;
    const p=y*width+x;
    if (excluded?.[p] || !mask[p] || seen.has(p)) return;
    seen.add(p); output.push(p);
  }
  function nearest(px,py) {
    const cx=Math.round(px),cy=Math.round(py);
    let best=-1,dist=Infinity;
    for(let dy=-radius;dy<=radius;dy++) for(let dx=-radius;dx<=radius;dx++) {
      const x=cx+dx,y=cy+dy;
      if(x<0||y<0||x>=width||y>=height)continue;
      if(roi && (x<roi.x||y<roi.y||x>=roi.x+roi.width||y>=roi.y+roi.height))continue;
      const p=y*width+x,d=dx*dx+dy*dy;
      if(d>radius*radius || d>=dist || !mask[p] || excluded?.[p])continue;
      dist=d;best=p;
    }
    return best;
  }
  let last=null,previous=-1,missingSamples=0,broken=false;
  for(let i=0;i<points.length&&output.length<maxPixels&&!broken;i++){
    const point=points[i];
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)){broken=true;break;}
    const steps=last?Math.max(1,Math.ceil(Math.hypot(point.x-last.x,point.y-last.y)*2)):0;
    for(let t=0;t<=steps && output.length<maxPixels;t++){
      // Consecutive pointer events often share an endpoint. Deduplicate it.
      if(last&&t===0)continue;
      const px=last?last.x+(point.x-last.x)*t/steps:point.x;
      const py=last?last.y+(point.y-last.y)*t/steps:point.y;
      const p=nearest(px,py);
      if(p<0){
        if(previous>=0&&++missingSamples>2){broken=true;break;}
        continue;
      }
      const x=p%width,y=Math.floor(p/width);
      if(previous>=0){
        const pxOld=previous%width,pyOld=Math.floor(previous/width);
        // A new disconnected line must be a fresh, separate user stroke.
        if(Math.max(Math.abs(x-pxOld),Math.abs(y-pyOld))>2){broken=true;break;}
      }
      add(x,y);previous=p;missingSamples=0;
    }
    last=point;
  }
  return output;
}
export function strokePreviewMask(indices,width,roi) {
  const mask=new Uint8Array(roi.width*roi.height);
  for(const p of indices){
    const x=p%width-roi.x,y=Math.floor(p/width)-roi.y;
    if(x>=0&&y>=0&&x<roi.width&&y<roi.height)mask[y*roi.width+x]=1;
  }
  return mask;
}

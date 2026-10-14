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
  let last=null;
  for(let i=0;i<points.length&&output.length<maxPixels;i++){
    const point=points[i];
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)){last=null;continue;}
    if(!last){const p=nearest(point.x,point.y);if(p>=0)add(p%width,Math.floor(p/width));last=point;continue;}
    const dx=point.x-last.x,dy=point.y-last.y;
    const samples=Math.max(1,Math.ceil(Math.hypot(dx,dy)*2));
    let previous=-1;
    for(let t=0;t<=samples && output.length<maxPixels;t++){
      const p=nearest(last.x+dx*t/samples,last.y+dy*t/samples);
      if(p<0){previous=-1;continue;}
      const x=p%width,y=Math.floor(p/width);
      // If a mouse stroke jumps across a large empty gap, do not invent a
      // connecting label. Only actual candidate pixels are added.
      if(previous>=0){
        const px=previous%width,py=Math.floor(previous/width);
        if(Math.max(Math.abs(x-px),Math.abs(y-py))>2)previous=-1;
      }
      add(x,y);previous=p;
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

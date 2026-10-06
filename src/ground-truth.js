// Labels: 0 unknown, 1 boundary, 2 interior, 3 excluded.
export function paintStroke(mask, width, height, points, label, radius) {
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*2));
    for(let s=0;s<=steps;s++) {
      const x=a.x+(b.x-a.x)*s/steps, y=a.y+(b.y-a.y)*s/steps;
      for(let yy=Math.max(0,Math.floor(y-radius));yy<=Math.min(height-1,Math.ceil(y+radius));yy++)
        for(let xx=Math.max(0,Math.floor(x-radius));xx<=Math.min(width-1,Math.ceil(x+radius));xx++)
          if(Math.hypot(xx-x,yy-y)<=radius) mask[yy*width+xx]=label;
    }
  }
}
export function labelGrains(mask,width,height) {
  const ids=new Uint32Array(mask.length), queue=new Int32Array(mask.length), grains=[];
  for(let p=0;p<mask.length;p++) {
    if(mask[p]!==2 || ids[p]) continue;
    const id=grains.length+1;let head=0,tail=1, incomplete=false;queue[0]=p;ids[p]=id;
    while(head<tail) {
      const q=queue[head++],x=q%width,y=Math.floor(q/width);
      if(!x||!y||x===width-1||y===height-1) incomplete=true;
      for(const n of [x>0?q-1:-1,x<width-1?q+1:-1,y>0?q-width:-1,y<height-1?q+width:-1]) {
        if(n<0)continue;
        if(mask[n]===0||mask[n]===3) incomplete=true;
        if(mask[n]===2&&!ids[n]){ids[n]=id;queue[tail++]=n;}
      }
    }
    grains.push({id,pixels:tail,incomplete});
  }
  return {ids,grains};
}
export function fillInterior(mask,width,height,p) {
  if(mask[p]===1||mask[p]===3)return 0;
  const seen=new Uint8Array(mask.length),queue=[p];seen[p]=1;
  for(let i=0;i<queue.length;i++) {
    const q=queue[i],x=q%width,y=Math.floor(q/width);
    for(const n of [x>0?q-1:-1,x<width-1?q+1:-1,y>0?q-width:-1,y<height-1?q+width:-1])
      if(n>=0&&!seen[n]&&mask[n]!==1&&mask[n]!==3){seen[n]=1;queue.push(n);}
  }
  for(const q of queue)mask[q]=2;
  return queue.length;
}
export async function decodeBmpCrop(file,h,r) {
  if(![r.x,r.y,r.width,r.height].every(Number.isInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>h.width||r.y+r.height>h.height||r.width*r.height>4194304)throw new Error('範囲は画像内・最大2048×2048相当で指定してください。');
  const rgba=new Uint8ClampedArray(r.width*r.height*4);
  for(let y=0;y<r.height;y++) {
    const fy=h.topDown?r.y+y:h.height-1-r.y-y;
    const start=h.pixelOffset+fy*h.rowStride+r.x*h.bytesPerPixel;
    const row=new Uint8Array(await file.slice(start,start+r.width*h.bytesPerPixel).arrayBuffer());
    for(let x=0;x<r.width;x++){const p=(y*r.width+x)*4,s=x*h.bytesPerPixel;rgba[p]=row[s+2];rgba[p+1]=row[s+1];rgba[p+2]=row[s];rgba[p+3]=255;}
  }
  return rgba;
}

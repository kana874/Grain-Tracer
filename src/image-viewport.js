// Match the main viewer: 2–800%, 1.12x wheel steps, cursor-anchored zoom.
export function zoomView(view, x, y, scale) {
  const next = Math.max(0.02, Math.min(8, scale));
  return {scale:next,tx:x-(x-view.tx)/view.scale*next,ty:y-(y-view.ty)/view.scale*next};
}
export function centeredView(width, height, viewportWidth, viewportHeight, scale) {
  return {scale,tx:(viewportWidth-width*scale)/2,ty:(viewportHeight-height*scale)/2};
}
export function fitView(width, height, viewportWidth, viewportHeight, margin=24) {
  const scale=Math.max(0.02,Math.min(8,(viewportWidth-margin*2)/width,(viewportHeight-margin*2)/height));
  return centeredView(width,height,viewportWidth,viewportHeight,scale);
}
export function viewPoint(view,x,y) { return {x:(x-view.tx)/view.scale,y:(y-view.ty)/view.scale}; }

export function setupImageViewport(viewer,stage,{getSize,enabled=()=>true,canZoom=()=>true,leftPan=()=>false,onChange=()=>{}}) {
  let view={scale:1,tx:0,ty:0},pan=null;
  function apply(next){view=next;stage.style.transform=`translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;onChange(view);}
  function local(e){const r=viewer.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  function point(e){const p=local(e);return viewPoint(view,p.x,p.y);}
  function fit(){const s=getSize();apply(fitView(s.width,s.height,viewer.clientWidth,viewer.clientHeight));}
  function actual(){const s=getSize();apply(centeredView(s.width,s.height,viewer.clientWidth,viewer.clientHeight,1));}
  function zoom(scale){apply(zoomView(view,viewer.clientWidth/2,viewer.clientHeight/2,scale));}
  viewer.addEventListener('wheel',e=>{
    if(!enabled())return;e.preventDefault();e.stopPropagation();if(!canZoom()||pan||!e.deltaY)return;
    const p=local(e);apply(zoomView(view,p.x,p.y,view.scale*(e.deltaY<0?1.12:1/1.12)));
  },{passive:false});
  viewer.addEventListener('pointerdown',e=>{
    if(!enabled()||pan||!canZoom()||(e.button!==1&&!(e.button===0&&leftPan())))return;
    e.preventDefault();e.stopImmediatePropagation();viewer.focus({preventScroll:true});
    pan={id:e.pointerId,x:e.clientX,y:e.clientY,tx:view.tx,ty:view.ty};viewer.classList.add('dragging');viewer.setPointerCapture(e.pointerId);
  });
  viewer.addEventListener('pointermove',e=>{
    if(!pan||e.pointerId!==pan.id)return;e.stopImmediatePropagation();
    apply({...view,tx:pan.tx+e.clientX-pan.x,ty:pan.ty+e.clientY-pan.y});
  });
  function end(e){if(!pan||pan.id!==e.pointerId)return;pan=null;viewer.classList.remove('dragging');if(viewer.hasPointerCapture(e.pointerId))viewer.releasePointerCapture(e.pointerId);e.stopImmediatePropagation();}
  for(const type of ['pointerup','pointercancel','lostpointercapture'])viewer.addEventListener(type,end);
  viewer.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
  return {fit,actual,zoom,point,getView:()=>({...view}),resetPan:()=>{if(pan&&viewer.hasPointerCapture(pan.id))viewer.releasePointerCapture(pan.id);pan=null;viewer.classList.remove('dragging');}};
}

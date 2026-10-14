export const ZOOM_STEPS=[0.25,0.5,0.75,1,1.5,2,3,4,6,8];
export function nextWheelZoom(current,delta){
  if(!Number.isFinite(delta)||delta===0)return current;
  const factor=delta<0?1.2:1/1.2;
  return Math.max(0.25,Math.min(8,Math.round(current*factor*1000)/1000));
}
export function zoomAroundCursor({scrollLeft,scrollTop,scale,clientX,clientY,viewportLeft,viewportTop},newScale){
  const x=clientX-viewportLeft,y=clientY-viewportTop;
  const ratio=newScale/scale;
  return {scrollLeft:Math.max(0,(scrollLeft+x)*ratio-x),
    scrollTop:Math.max(0,(scrollTop+y)*ratio-y)};
}
export function dragViewport(start,current){
  return {scrollLeft:Math.max(0,start.scrollLeft-(current.x-start.x)),
    scrollTop:Math.max(0,start.scrollTop-(current.y-start.y))};
}
export function eventToRoiPixel(clientX,clientY,rect,width,height){
  if(!rect.width||!rect.height)return null;
  const x=Math.floor((clientX-rect.left)*width/rect.width);
  const y=Math.floor((clientY-rect.top)*height/rect.height);
  if(x<0||y<0||x>=width||y>=height)return null;
  return {x,y};
}

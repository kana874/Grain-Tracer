import test from 'node:test';
import assert from 'node:assert/strict';
import {zoomView,centeredView,fitView,viewPoint,setupImageViewport} from '../src/image-viewport.js';

test('zoom preserves original pixel beneath cursor, including scale limits',()=>{
 const v={scale:.4,tx:-150,ty:42},p=viewPoint(v,230,190);
 for(const scale of [.001,.4*1.12,1,4,999]){
  const z=zoomView(v,230,190,scale),q=viewPoint(z,230,190);
  assert.ok(Math.abs(q.x-p.x)<1e-8&&Math.abs(q.y-p.y)<1e-8);
  assert.ok(z.scale>=.02&&z.scale<=8);
 }
});
test('fit and 100% center the image; pan maps back to unchanged source coordinates',()=>{
 const fitted=fitView(2000,1000,1000,500);
 assert.equal(fitted.scale,.452);
 assert.deepEqual(viewPoint(fitted,500,250),{x:1000,y:500});
 assert.deepEqual(centeredView(2000,1000,1000,500,1),{scale:1,tx:-500,ty:-250});
 assert.deepEqual(viewPoint({scale:2,tx:-100,ty:50},300,250),{x:200,y:100});
});
function fixture(){
 const viewer=new EventTarget(),captures=new Set(),classes=new Set(),stage={style:{}};
 Object.assign(viewer,{clientWidth:800,clientHeight:400,getBoundingClientRect:()=>({left:40,top:70}),focus(){},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)});
 const send=(type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);viewer.dispatchEvent(e);return e;};
 return {viewer,stage,send,classes,captures};
}
test('middle pan intercepts drawing in every tool, releases capture and never changes scale',()=>{
 const f=fixture(),viewport=setupImageViewport(f.viewer,f.stage,{getSize:()=>({width:400,height:200})});
 let drawings=0;f.viewer.addEventListener('pointerdown',()=>drawings++);
 viewport.actual();const before=viewport.getView();
 assert.ok(f.send('pointerdown',{button:1,pointerId:7,clientX:100,clientY:100}).defaultPrevented);
 f.send('pointermove',{pointerId:8,clientX:500,clientY:500});assert.deepEqual(viewport.getView(),before);
 f.send('pointermove',{pointerId:7,clientX:160,clientY:80});
 assert.deepEqual(viewport.getView(),{scale:1,tx:before.tx+60,ty:before.ty-20});assert.equal(drawings,0);
 f.send('pointerup',{pointerId:7});assert.equal(f.captures.size,0);assert.ok(!f.classes.has('dragging'));
 f.send('pointerdown',{button:0,pointerId:7,clientX:100,clientY:100});assert.equal(drawings,1);
});
test('wheel matches main viewer steps; drawing blocks zoom and left pan is opt-in',()=>{
 const f=fixture();let drawing=false,panTool=false;
 const v=setupImageViewport(f.viewer,f.stage,{getSize:()=>({width:400,height:200}),canZoom:()=>!drawing,leftPan:()=>panTool});
 v.actual();f.send('wheel',{deltaY:-20,clientX:240,clientY:170});assert.equal(v.getView().scale,1.12);
 const point=v.point({clientX:240,clientY:170});assert.deepEqual(point,{x:0,y:0});
 drawing=true;const before=v.getView();f.send('wheel',{deltaY:-20,clientX:240,clientY:170});assert.deepEqual(v.getView(),before);
 drawing=false;panTool=true;f.send('pointerdown',{button:0,pointerId:1,clientX:200,clientY:200});assert.ok(f.classes.has('dragging'));
 f.send('lostpointercapture',{pointerId:1});assert.ok(!f.classes.has('dragging'));
});

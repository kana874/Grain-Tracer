import test from 'node:test';
import assert from 'node:assert/strict';
import {cropSizeForArea,positionCrop,resizeCropForArea,previewToSource} from '../src/ground-truth-selection.js';
import {MAX_CROP_PIXELS,decodeBmpCrop} from '../src/ground-truth.js';

test('all area fractions preserve source aspect with subpixel rounding for portrait and landscape sources',()=>{
 for(const [w,h] of [[18000,12000],[713,1109],[1920,1080]])for(let n=8;n<=32;n++){
  const size=cropSizeForArea(w,h,n),scale=1/Math.sqrt(n);
  assert.ok(Math.abs(size.width-w*scale)<=.5);
  assert.ok(Math.abs(size.height-h*scale)<=.5);
  assert.ok(Math.abs(size.width*size.height-w*h/n)<=.5*(w+h)*scale+.25);
  assert.ok(size.width*size.height<=MAX_CROP_PIXELS);
 }
 assert.deepEqual(cropSizeForArea(1600,800,16),{width:400,height:200});
 assert.throws(()=>cropSizeForArea(1600,800,7));
 assert.throws(()=>cropSizeForArea(1600,800,33));
});
test('resize retains center and clamps full rectangle at every image edge',()=>{
 const r={x:600,y:300,width:400,height:200};
 const small=resizeCropForArea(1600,800,r,32);
 assert.ok(Math.abs(small.x+small.width/2-800)<=.5);
 assert.ok(Math.abs(small.y+small.height/2-400)<=.5);
 assert.deepEqual(positionCrop(1600,800,r,-400,-200),{...r,x:0,y:0});
 assert.deepEqual(positionCrop(1600,800,r,9999,9999),{...r,x:1200,y:600});
 const grown=resizeCropForArea(1600,800,{...small,x:0,y:0},8);
 assert.equal(grown.x,0);assert.equal(grown.y,0);
 assert.ok(grown.x+grown.width<=1600&&grown.y+grown.height<=800);
});
test('preview coordinates map to original pixels independently of CSS size or offset',()=>{
 const bounds={left:70,top:200,width:320,height:160};
 assert.deepEqual(previewToSource(230,280,bounds,16000,8000),{x:8000,y:4000});
 assert.deepEqual(previewToSource(-100,-100,bounds,16000,8000),{x:0,y:0});
 assert.deepEqual(previewToSource(9999,9999,bounds,16000,8000),{x:16000,y:8000});
});
test('native crops larger than the previous cap are accepted without changing source resolution',async()=>{
 const w=2049,h=2048,row=new Uint8Array(w*3);row.set([9,8,7]);
 const file={slice:()=>new Blob([row])};
 const header={width:w,height:h,topDown:true,rowStride:w*3,pixelOffset:0,bytesPerPixel:3};
 const pixels=await decodeBmpCrop(file,header,{x:0,y:0,width:w,height:h});
 assert.equal(pixels.length,w*h*4);
 assert.deepEqual(Array.from(pixels.slice(0,4)),[7,8,9,255]);
 await assert.rejects(decodeBmpCrop(file,{...header,width:MAX_CROP_PIXELS}, {x:0,y:0,width:MAX_CROP_PIXELS,height:2}));
});

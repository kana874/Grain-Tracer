import test from 'node:test';
import assert from 'node:assert/strict';
import {paintStroke,fillInterior,labelGrains,decodeBmpCrop} from '../src/ground-truth.js';
test('closed grain fill stops at boundary; erasing a wall marks grain incomplete',()=>{
 const m=new Uint8Array(49);paintStroke(m,7,7,[{x:1,y:1},{x:5,y:1},{x:5,y:5},{x:1,y:5},{x:1,y:1}],1,.5);
 assert.equal(fillInterior(m,7,7,24),9);let g=labelGrains(m,7,7);assert.equal(g.grains.length,1);assert.equal(g.grains[0].incomplete,false);assert.equal(m[0],0);
 m[10]=0;assert.equal(labelGrains(m,7,7).grains[0].incomplete,true);
});
test('exclusion splits interior IDs and is not a valid grain',()=>{const m=Uint8Array.from([2,3,2]);const g=labelGrains(m,3,1);assert.deepEqual(Array.from(g.ids),[1,0,2]);assert.ok(g.grains.every(v=>v.incomplete));});
test('crop reads exact source coordinates including bottom-up BMP rows',async()=>{
 const b=new Uint8Array(24);b.set([3,2,1,6,5,4],0);b.set([9,8,7,12,11,10],12);
 const h={width:2,height:2,topDown:false,rowStride:12,pixelOffset:0,bytesPerPixel:3};
 assert.deepEqual(Array.from(await decodeBmpCrop(new Blob([b]),h,{x:1,y:0,width:1,height:2})),[10,11,12,255,4,5,6,255]);
 await assert.rejects(decodeBmpCrop(new Blob([b]),h,{x:2,y:0,width:1,height:1}));
});

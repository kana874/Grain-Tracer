import test from 'node:test';
import assert from 'node:assert/strict';
import { positionLocalRoi, withinLocalRoi, localAbCounts, filterLocalReview } from '../src/local-ab.js';
import { createProjectSnapshot, migrateProject } from '../src/project.js';

test('ROI centered at preview edge stays inside source', () => {
  const a=positionLocalRoi(1400,900,256,0,0);
  assert.deepEqual(a,{x:0,y:0,width:256,height:256});
  const b=positionLocalRoi(1400,900,256,1399,899);
  assert.deepEqual(b,{x:1144,y:644,width:256,height:256});
  assert.equal(withinLocalRoi(a,0,0),true);
  assert.equal(withinLocalRoi(a,256,10),false);
  const small=positionLocalRoi(80,65,256,0,0);
  assert.deepEqual(small,{x:0,y:0,width:80,height:65});
});
test('comparison counts only the selected ROI and excludes masked pixels', () => {
  const width=6,height=6,a=new Uint8Array(width*height),b=new Uint8Array(width*height);
  a[1*width+1]=1; a[2*width+2]=1; a[5*width+5]=1;
  b[1*width+1]=1; b[3*width+3]=1; b[5*width+5]=1;
  const roi={x:0,y:0,width:4,height:4};
  assert.deepEqual(localAbCounts(a,b,width,roi),{a:2,b:2,onlyA:1,onlyB:1,shared:1});
  const excluded=new Uint8Array(width*height); excluded[1*width+1]=1;
  assert.deepEqual(localAbCounts(a,b,width,roi,excluded),{a:1,b:1,onlyA:1,onlyB:1,shared:0});
  assert.deepEqual(filterLocalReview([7,14,21,35],width,roi,excluded),[14,21]);
});
test('A/B votes survive project v4 round-trip separately from reference labels', () => {
  const votes=[{schema:'graintracer-local-ab-v1',winner:'b',
    coordinateSystem:'analysis-preview',roi:{x:0,y:0,width:4,height:4},
    createdAt:'2026-10-14T00:00:00Z',variant:'plus8'}];
  const p=createProjectSnapshot({source:{name:'x.bmp'},preview:{width:4,height:4,scale:1},settings:{},
    referenceMask:new Uint8Array(16),referenceCenterline:new Uint8Array(16),
    negativeCenterline:new Uint8Array(16),negativeMask:new Uint8Array(16),
    localAbReviews:votes,feedbackReviews:[],fullEvaluationRois:[]});
  assert.equal(p.formatVersion,4);
  assert.deepEqual(migrateProject(p).localAbReviews,votes);
  assert.deepEqual(migrateProject({...p,localAbReviews:undefined}).localAbReviews,[]);
  assert.deepEqual([...p.reference.centerline].length > 0,true);
});

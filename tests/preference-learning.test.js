import test from "node:test";
import assert from "node:assert/strict";
import {
  changeSetting, comparisonKey, proposePreferenceCandidate,
  advancePreference, buildPreferenceVote, preferenceParameterSnapshot,
} from "../src/preference-optimizer.js";
import { rasterizeGuidedStroke } from "../src/stroke-review.js";
import { recommendDisagreementRoi } from "../src/active-roi.js";
import { evaluatePreferenceAdoption } from "../src/preference-adoption.js";
import { migrateProject, createProjectSnapshot } from "../src/project.js";

const base={sensitivity:65,darkWeight:20,ridgeWeight:40,colorWeight:20,
  dendriteWeight:20,negativeEvidenceWeight:35,minComponent:24,centerlineNms:true,
  scoreMode:"legacy"};

test("adaptive challenger modifies settings, chooses diverse arms and retains champion unless B wins",()=>{
  const first=proposePreferenceCandidate(base,[],{round:0});
  assert.ok(first?.actionKey);
  assert.notEqual(comparisonKey(first.parameters),comparisonKey(base));
  const others=proposePreferenceCandidate(base,[{
    actionKey:first.actionKey,winner:"a",aKey:comparisonKey(base),bKey:comparisonKey(first.parameters)
  }],{round:1});
  assert.ok(others);
  assert.notEqual(others.actionKey,first.actionKey);
  assert.deepEqual(advancePreference(base,first.parameters,"a"),base);
  assert.deepEqual(advancePreference(base,first.parameters,"neither"),base);
  assert.deepEqual(advancePreference(base,first.parameters,"uncertain"),base);
  assert.deepEqual(advancePreference(base,first.parameters,"b"),first.parameters);
  assert.equal(changeSetting({...base,sensitivity:100},["sensitivity",5]),null);
  const v=buildPreferenceVote({champion:base,challenger:first.parameters,winner:"b",
    proposal:first,fingerprint:"sample",roi:{x:0,y:0,width:128,height:128},round:3});
  assert.equal(v.actionKey,first.actionKey);
  assert.equal(v.coordinateSystem,"analysis-preview");
});

test("guided stroke labels only nearest candidates on the user path, once",()=>{
  const w=40,h=30,mask=new Uint8Array(w*h);
  for(let x=3;x<36;x++){mask[8*w+x]=1;mask[14*w+x]=1;}
  const path=[{x:3,y:8},{x:18,y:8},{x:34,y:8}];
  const indices=rasterizeGuidedStroke(path,mask,w,h,{snapRadius:1,
    roi:{x:0,y:0,width:40,height:12}});
  assert.ok(indices.length>15);
  assert.ok(indices.every(p=>Math.floor(p/w)===8));
  assert.equal(new Set(indices).size,indices.length);
  const excluded=new Uint8Array(w*h);
  excluded[8*w+10]=1;
  const filtered=rasterizeGuidedStroke(path,mask,w,h,{
    snapRadius:1,roi:{x:0,y:0,width:40,height:12},exclusionMask:excluded,
  });
  assert.ok(!filtered.includes(8*w+10));
});

test("active ROI prioritizes disagreement but never selects a Validation/Test ROI",()=>{
  const w=256,h=256,a=new Uint8Array(w*h),b=new Uint8Array(w*h);
  for(let y=0;y<100;y++)for(let x=0;x<100;x++)b[y*w+x]=1;
  for(let y=0;y<100;y++)for(let x=160;x<240;x++)b[y*w+x]=1;
  const full=recommendDisagreementRoi(a,b,w,h,128);
  assert.equal(full.roi.x,0);
  const protectedRois=[{x0:0,y0:0,x1:127,y1:127,evaluationRole:"test",verified:true}];
  const filtered=recommendDisagreementRoi(a,b,w,h,128,{protectedRois});
  assert.ok(filtered);
  assert.equal(filtered.roi.x>=128,true);
  assert.equal(filtered.roi.y<128,true);
});

test("auto-adoption strictly requires verified validation, validates F1 and never uses Test fallback",()=>{
  const w=50,h=50,N=w*h,ref=new Uint8Array(N);
  const before=new Uint8Array(N),after=new Uint8Array(N);
  for(let y=5;y<43;y++){
    ref[y*w+12]=1;before[y*w+12]=1;after[y*w+12]=1;
    before[y*w+16]=1;
  }
  const validation={x0:0,x1:24,y0:0,y1:49,evaluationRole:"validation",verified:true};
  const testRoi={x0:25,x1:49,y0:0,y1:49,evaluationRole:"test",verified:true};
  assert.equal(evaluatePreferenceAdoption(before,after,ref,w,h,{
    imageRole:"development",fullEvaluationRois:[testRoi],tolerance:0}).accepted,false);
  assert.equal(evaluatePreferenceAdoption(before,after,ref,w,h,{
    imageRole:"development",fullEvaluationRois:[{...validation,verified:false}],tolerance:0}).accepted,false);
  assert.equal(evaluatePreferenceAdoption(before,after,ref,w,h,{
    imageRole:"test",fullEvaluationRois:[validation],tolerance:0}).accepted,false);
  const guard=evaluatePreferenceAdoption(before,after,ref,w,h,{
    imageRole:"development",fullEvaluationRois:[validation,testRoi],tolerance:0});
  assert.equal(guard.accepted,true);
  assert.equal(guard.validationRoiCount,1);
  assert.ok(guard.after.f1>guard.before.f1);
  const worse=after.slice();
  for(let y=20;y<43;y++)worse[y*w+12]=0;
  const reject=evaluatePreferenceAdoption(before,worse,ref,w,h,{
    imageRole:"development",fullEvaluationRois:[validation],tolerance:0});
  assert.equal(reject.accepted,false);
  assert.match(reject.reason,/Recall/);
});

test("legacy project keeps format v4 while preserving v2 votes and adoption audits",()=>{
  const N=32*32,m=new Uint8Array(N);
  const votes=[{schema:"graintracer-preference-v2",winner:"b",actionKey:"sensitivity:5"}];
  const audits=[{schema:"graintracer-preference-adoption-v1",accepted:false,reason:"no validation"}];
  const project=createProjectSnapshot({source:{name:"test.bmp"},preview:{width:32,height:32,scale:1},
    referenceMask:m,referenceCenterline:m,negativeMask:m,negativeCenterline:m,
    settings:{},localAbReviews:votes,preferenceAdoptions:audits});
  assert.equal(project.formatVersion,4);
  const migrated=migrateProject(project);
  assert.deepEqual(migrated.localAbReviews,votes);
  assert.deepEqual(migrated.preferenceAdoptions,audits);
  assert.deepEqual(migrateProject({...project,preferenceAdoptions:undefined}).preferenceAdoptions,[]);
});

test("preference votes contain no large image-mask arrays",()=>{
  const withMasks={...base,negativeMask:new Uint8Array(100000),
    exclusionMask:new Uint8Array(100000),classifierModel:{weights:Array(100).fill(3)}};
  const compact=preferenceParameterSnapshot(withMasks);
  assert.equal(compact.negativeMask,undefined);
  assert.equal(compact.classifierModel,undefined);
  const p=proposePreferenceCandidate(withMasks,[]);
  const v=buildPreferenceVote({champion:withMasks,challenger:p.parameters,winner:"b",
    proposal:p,fingerprint:"t",roi:{x:0,y:0,width:30,height:30},round:2});
  assert.ok(JSON.stringify(v).length<1000);
  assert.equal(JSON.stringify(v).includes("exclusionMask"),false);
});

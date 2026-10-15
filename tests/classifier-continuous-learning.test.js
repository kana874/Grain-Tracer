import test from "node:test";
import assert from "node:assert/strict";
import { createCompactTrainingPacket, trainClassifierInWorker,
  verifyLearningPartitions, evaluateAutoClassifierGuard } from "../src/classifier-learning.js";
import { createLearningCoordinator } from "../src/learning-coordinator.js";
import { trainLogisticBoundaryClassifier, makeClassifierPredictor,
  predictBoundaryProbability } from "../src/boundary-classifier.js";
import { buildBoundaryCandidates, buildBoundaryMask } from "../src/analysis.js";
import { createProjectSnapshot, migrateProject } from "../src/project.js";

function fixture() {
  const width=80,height=40,n=width*height;
  const positive=new Uint8Array(n),negative=new Uint8Array(n);
  const dark=new Uint8Array(n),ridge=new Uint8Array(n);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=y*width+x;
    dark[p]=(x<20||x>=40&&x<60)?245:12;
    ridge[p]=dark[p];
    if(x<20)positive[p]=1;
    else if(x<40)negative[p]=1;
    else if(x<60)positive[p]=1; // Deliberately held-out Validation labels.
    else negative[p]=1;
  }
  const features={width,height,dark,ridge,color:ridge,
    dendrite:new Uint8Array(n),dendriteLinePenalty:new Uint8Array(n),
    dendriteCoherence:new Uint8Array(n),ridgeScale:new Uint8Array(n),
    orientation:new Uint8Array(n),orientationAngle:new Float32Array(n),
    featureMargins:{dark:0,ridge:0,color:0,dendrite:0,dendriteLinePenalty:0}};
  const training={x0:0,y0:0,x1:39,y1:39,evaluationRole:"training",verified:true};
  const validation={x0:40,y0:0,x1:79,y1:39,evaluationRole:"validation",verified:true};
  const roiMask=new Uint8Array(n);
  for(let y=0;y<height;y++)roiMask.fill(1,y*width,y*width+40);
  return {features,positive,negative,training,validation,roiMask};
}

test("compact packets only contain Training pixels, have bounded bytes and train",async()=>{
  const {features,positive,negative,roiMask}=fixture();
  const packet=createCompactTrainingPacket(features,positive,negative,
    {roiMask,maxSamplesPerClass:128,iterations:30});
  assert.equal(packet.features.width,256);
  assert.equal(packet.positiveMask.reduce((a,b)=>a+b),128);
  assert.equal(packet.negativeMask.reduce((a,b)=>a+b),128);
  assert.equal(packet.sampleCounts.positiveAvailable,800);
  assert.ok(packet.features.dark.every((value,index)=>index<128?value===245:value===12));
  assert.equal(packet.features.dark.byteLength,256);
  const model=await trainClassifierInWorker(packet);
  assert.equal(model.sampleCounts.positiveAvailable,800);
  assert.equal(model.sampleCounts.negativeAvailable,800);
  assert.ok(model.coefficients[0]>0);
});

test("compiled classifier matches reference probability at each pixel",()=>{
  const {features,positive,negative,roiMask}=fixture();
  const model=trainLogisticBoundaryClassifier(features,positive,negative,
    {roiMask,iterations:30,maxSamplesPerClass:128});
  const compiled=makeClassifierPredictor(features,model);
  for(let p=0;p<features.width*features.height;p+=17){
    assert.ok(Math.abs(compiled(p)-predictBoundaryProbability(features,p,model))<1e-12);
  }
  const candidates=buildBoundaryCandidates(features,{scoreMode:"classifier",
    classifierModel:model,collectEvidence:false,centerlineNms:false,minComponent:1});
  assert.equal(candidates.positiveEvidence,null);
  assert.equal(candidates.negativeEvidence,null);
});

test("full mask and explicitly disabled evidence output preserve prediction",async()=>{
  const {features}=fixture();
  const opt={scoreMode:"evidence",negativeEvidenceWeight:40,centerlineNms:false,
    sensitivity:50,minComponent:1,hysteresis:{enabled:false}};
  const regular=buildBoundaryCandidates(features,opt);
  const reduced=buildBoundaryCandidates(features,{...opt,collectEvidence:false});
  assert.deepEqual(reduced.mask,regular.mask);
  assert.deepEqual(reduced.score,regular.score);
  const full=await buildBoundaryMask(features,opt);
  assert.equal(full.length,features.width*features.height);
});

test("independent split is mandatory, rejecting provisional/overlapping ROIs",()=>{
  const {training,validation}=fixture();
  assert.equal(verifyLearningPartitions([training,validation]).ok,true);
  assert.equal(verifyLearningPartitions([training,{...validation,verified:false}]).ok,false);
  assert.equal(verifyLearningPartitions([training,{...validation,x0:30}]).ok,false);
  assert.equal(verifyLearningPartitions([training]).ok,false);
});

test("promotion requires genuine F1 improvement and limited negative leakage",()=>{
  const before={f1:.73,precision:.70,recall:.77,negativeLeakage:.03,
    topology:{weightedClosureScore:.8,openAfterMaxRadius:2}};
  assert.equal(evaluateAutoClassifierGuard(before,
    {...before,f1:.731}).accepted,false);
  assert.equal(evaluateAutoClassifierGuard(before,
    {...before,f1:.76,negativeLeakage:.05}).accepted,false);
  assert.equal(evaluateAutoClassifierGuard(before,
    {...before,f1:.76,precision:.72,recall:.77,negativeLeakage:.032}).accepted,true);
});

test("edit bursts create one automatic learning round",async()=>{
  let executed=0;
  const controller=createLearningCoordinator({ready:()=>true,
    run:async()=>{executed++;},debounceMs:5});
  controller.changed();controller.changed();controller.changed();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(executed,1);
  controller.dispose();
});

test("project v4 persists bounded per-image learning audits",()=>{
  const mask=new Uint8Array(64);
  const classifierLearning={revision:9,validationRevision:4,lastTrainedRevision:8,
    status:"accepted",history:Array.from({length:75},(_,i)=>({revision:i}))};
  const project=createProjectSnapshot({source:{fingerprint:"img"},
    preview:{width:8,height:8,scale:1},settings:{},
    referenceMask:mask,referenceCenterline:mask,negativeMask:mask,
    classifierLearning});
  const restored=migrateProject(project);
  assert.equal(project.formatVersion,4);
  assert.equal(restored.classifierLearning.revision,9);
  assert.equal(restored.classifierLearning.history.length,50);
});

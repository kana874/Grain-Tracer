import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessClassifierWizard } from "../src/classifier-wizard.js";
import { createLearningCoordinator } from "../src/learning-coordinator.js";

const training={x0:0,y0:0,x1:29,y1:29,verified:true,evaluationRole:"training"};
const validation={x0:30,y0:0,x1:59,y1:29,verified:true,
  source:"validation-wizard-confirmed",evaluationRole:"validation"};
function data({rois=[training,validation],fill=true,learning=null,classifier=null}={}) {
  const width=60,height=30,n=width*height,positiveMask=new Uint8Array(n),
    negativeMask=new Uint8Array(n);
  if(fill)for(let x=0;x<30;x++) {
    positiveMask[5*width+x]=1;
    negativeMask[15*width+x]=1;
  }
  return {width,height,rois,positiveMask,negativeMask,imageRole:"development",
    exclusionMask:new Uint8Array(n),learning,classifier};
}

test("wizard waits for image and then guides Training -> labels -> Validation -> train",()=>{
  assert.equal(assessClassifierWizard({}).step,"image");
  assert.equal(assessClassifierWizard(data({rois:[]})).action,"create-training");
  assert.equal(assessClassifierWizard(data({rois:[training],fill:false})).action,"edit-positive");
  const onlyPositive=data({rois:[training],fill:false});
  for(let x=0;x<30;x++)onlyPositive.positiveMask[5*60+x]=1;
  assert.equal(assessClassifierWizard(onlyPositive).action,"edit-negative");
  const missingValidation=assessClassifierWizard(data({rois:[training]}));
  assert.equal(missingValidation.action,"create-validation");
  const ready=assessClassifierWizard(data());
  assert.equal(ready.action,"train");
  assert.equal(ready.canTrain,true);
  assert.equal(ready.details.positive,24);
  assert.equal(ready.details.negative,24);
});

test("wizard never promotes unverified Validation or overlapping Training and Test",()=>{
  const provisional={...validation,verified:false};
  assert.equal(assessClassifierWizard(data({rois:[training,provisional]})).step,"validation");
  const legacy={...validation,source:"manual"};
  assert.equal(assessClassifierWizard(data({rois:[training,legacy]})).step,"validation");
  const overlap={...validation,x0:20};
  assert.equal(assessClassifierWizard(data({rois:[training,overlap]})).step,"blocked");
  assert.equal(assessClassifierWizard({...data(),imageRole:"test"}).step,"blocked");
});

test("wizard exposes accepted or rejected status without running learning",()=>{
  const learning={revision:10,lastTrainedRevision:10,status:"accepted"};
  const accepted=assessClassifierWizard(data({learning,classifier:{accepted:true}}));
  assert.equal(accepted.step,"complete");
  assert.equal(accepted.action,"retrain");
  const pending=assessClassifierWizard(data({learning:{...learning,revision:11},
    classifier:{accepted:true}}));
  assert.equal(pending.action,"train");
  const rejected=assessClassifierWizard(data({learning:{...learning,status:"rejected"},
    classifier:null}));
  assert.equal(rejected.step,"ready");
});

test("manual-only coordinator records edits but never runs or reschedules a timer",async()=>{
  let executions=0;
  const statuses=[];
  const coordinator=createLearningCoordinator({
    ready:()=>true,autoRun:false,debounceMs:2,
    run:async()=>{executions++;},
    onStatus:status=>statuses.push(status),
  });
  for(let i=0;i<15;i++)coordinator.changed();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(executions,0);
  assert.equal(statuses.at(-1),"pending");
  assert.equal(await coordinator.flush({manual:true}),true);
  assert.equal(executions,1);
  coordinator.changed();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(executions,1);
  coordinator.dispose();
});

test("UI routes pointer drawing to a deferred revision; classifier can only start from explicit buttons",async()=>{
  const app=await readFile(new URL("../src/app.js",import.meta.url),"utf8");
  const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
  assert.match(app,/autoRun:\s*false/);
  assert.match(app,/invalidateAfterReferenceEdit\(false,\s*\{\s*deferLearning:\s*true\s*\}\)/);
  assert.match(app,/if \(parts.length\) noteClassifierLearningChange\("labels"\)/);
  assert.match(app,/if \(automatic \|\| state.busy \|\| state.drawingReference/);
  assert.match(app,/addEventListener\("click", handleClassifierWizardNext\)/);
  assert.match(html,/id="classifierLearningWizard"/);
  assert.match(html,/id="classifierWizardNextButton"/);
  assert.match(html,/id="classifierWizardPositiveButton"/);
  assert.match(html,/id="classifierWizardNegativeButton"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildClosedNegativeRegionIndex, fillClosedNegativeRegion } from "../src/closed-negative-fill.js";
import { checkValidationFillBounds } from "../src/validation-fill-guard.js";
import { createProjectSnapshot, restoreReferenceMasks, PROJECT_VERSION } from "../src/project.js";

function referenceRing(w=72,h=72) {
  const mask=new Uint8Array(w*h);
  for(let x=10;x<=35;x++){mask[10*w+x]=1;mask[35*w+x]=1;}
  for(let y=10;y<=35;y++){mask[y*w+10]=1;mask[y*w+35]=1;}
  return {mask,w,h};
}

test("Validation Fill accepts a completely enclosed negative region inside its draft ROI",()=>{
  const {mask,w,h}=referenceRing();
  const options={safetyRadius:3,minPixels:12};
  const idx=buildClosedNegativeRegionIndex(mask,w,h,options);
  const candidate=fillClosedNegativeRegion(mask,w,h,{x:22,y:22},options);
  assert.equal(candidate.accepted,true);
  const decision=checkValidationFillBounds(idx,candidate,
    {x0:9,y0:9,x1:36,y1:36});
  assert.equal(decision.allowed,true);
  assert.equal(decision.outsidePixels,0);
  assert.ok(decision.insidePixels>12);
});

test("Validation Fill refuses a region extending past ROI with no silent clipping",()=>{
  const {mask,w,h}=referenceRing();
  const opts={safetyRadius:3,minPixels:12};
  const idx=buildClosedNegativeRegionIndex(mask,w,h,opts);
  const candidate=fillClosedNegativeRegion(mask,w,h,{x:22,y:22},opts);
  const partial={x0:16,y0:16,x1:29,y1:29};
  const decision=checkValidationFillBounds(idx,candidate,partial);
  assert.equal(decision.allowed,false);
  assert.equal(decision.reason,"outside-validation-roi");
  assert.ok(decision.outsidePixels>0);
  assert.deepEqual(mask,referenceRing().mask);
});

test("Invalid Fill result, malformed index and malformed ROI cannot bypass the guard",()=>{
  const {mask,w,h}=referenceRing();
  const idx=buildClosedNegativeRegionIndex(mask,w,h);
  const rect={x0:0,y0:0,x1:w-1,y1:h-1};
  assert.equal(checkValidationFillBounds(idx,{accepted:false,label:1},rect).allowed,false);
  assert.equal(checkValidationFillBounds(idx,{accepted:true,label:0},rect).allowed,false);
  assert.equal(checkValidationFillBounds({labels:new Uint8Array(1),safetyMask:new Uint8Array(1),width:w,height:h},
    {accepted:true,label:1},rect).allowed,false);
  assert.equal(checkValidationFillBounds(idx,{accepted:true,label:1},
    {x0:50,y0:50,x1:30,y1:30}).allowed,false);
  assert.equal(checkValidationFillBounds(idx,{accepted:true,label:1},null).allowed,true);
});

test("Legacy negative line and closed-fill seed data survive Project v4 save/restore",()=>{
  const {mask,w,h}=referenceRing();
  const manual=new Uint8Array(w*h);
  manual[15*w+15]=1;
  const line=new Uint8Array(w*h);
  line[15*w+15]=1;
  const seeds=[{x:22,y:22,borderAssisted:false}];
  const project=createProjectSnapshot({
    source:{name:"existing.bmp"},preview:{width:w,height:h,scale:1},
    referenceMask:mask,referenceCenterline:mask,negativeMask:manual,
    manualNegativeMask:manual,negativeCenterline:line,closedNegativeSeeds:seeds,
    settings:{},fullEvaluationRois:[{x0:0,y0:0,x1:50,y1:50,evaluationRole:"validation",verified:true}],
  });
  assert.equal(project.formatVersion,PROJECT_VERSION);
  const restored=restoreReferenceMasks(project);
  assert.deepEqual(restored.negativeCenterline,line);
  assert.deepEqual(restored.manualNegativeMask,manual);
  assert.deepEqual(restored.closedNegativeSeeds,seeds);
  assert.equal(restored.fullEvaluationRois[0].evaluationRole,"validation");
});

test("Standard UI hides negative pen, shows closed Fill and explains Validation behavior",async()=>{
  const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
  const css=await readFile(new URL("../styles.css",import.meta.url),"utf8");
  const app=await readFile(new URL("../src/app.js",import.meta.url),"utf8");
  const selector=css.match(/\.focus-mode \.toolbar > button[^\n]+/)[0];
  assert.ok(selector.includes(":not(#closedNegativeFillToolButton)"));
  assert.ok(!selector.includes(":not(#negativeToolButton)"));
  assert.match(css,/\.focus-mode #negativeToolButton\s*\{display:none !important;\}/);
  assert.ok(html.indexOf('id="eraseReferenceToolButton"')<
    html.indexOf('id="closedNegativeFillToolButton"'));
  assert.ok(html.includes('id="negativeToolButton"'));
  assert.match(html,/ROI外にはみ出す塗りつぶしは拒否/);
  assert.match(app,/const safety=checkValidationFillBounds\(rebuilt\.regionIndex,result,editingRoi\)/);
  assert.ok(app.indexOf('const safety=checkValidationFillBounds(')<
    app.indexOf('state.closedNegativeSeeds.push(acceptedSeed)'));
  assert.match(app,/if\(!advanced && state\.tool==="negative-reference"\)setTool\("pan"\)/);
  assert.match(app,/if\(validationEditingRect\(\)\) \$\("validationRoiAttest"\)\.checked=false/);
  assert.match(app,/item\.kind === "closed-fill-add"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  roiOverlapPixels, validationRoiConflicts,referencePixelsInRect,canVerifyValidationRoi,
  validationUsageAreas, recommendUnusedValidationRoi,
} from '../src/validation-roi.js';

const roi={x0:100,y0:50,x1:163,y1:113,source:'validation-wizard-draft',
  evaluationRole:'validation',verified:false};
const width=240,height=160;
const labels=new Uint8Array(width*height);
for(let x=105;x<=138;x++)labels[75*width+x]=1;

test('overlap works between inclusive ROI rects and A/B x/y/width/height entries',()=>{
  assert.equal(roiOverlapPixels(roi,{x:110,y:60,width:10,height:10}),100);
  assert.equal(roiOverlapPixels(roi,{x:164,y:50,width:30,height:30}),0);
});
test('new Validation creation rejects any old training ROI, vote and manual feedback overlaps',()=>{
  assert.equal(validationRoiConflicts(roi,[{x0:115,y0:55,x1:140,y1:80}],[]).ok,false);
  assert.equal(validationRoiConflicts(roi,[],[{roi:{x:101,y:75,width:40,height:40}}]).ok,false);
  assert.equal(validationRoiConflicts(roi,[],[], -1,[{x:104,y:63}]).ok,false);
  assert.equal(validationRoiConflicts(roi,[],[], -1,[{roi:{x:125,y:50,width:8,height:8}}]).ok,false);
  assert.equal(validationRoiConflicts(roi,[],[{roi:{x:180,y:120,width:10,height:10}}]).ok,true);
});
test('validation drafts and insufficient or unattested centerlines never enter verified set',()=>{
  const args={rect:roi,referenceCenterline:labels,width,height,
    existingRois:[{...roi}],ignoreIndex:0,
    minReferencePixels:20};
  assert.equal(referencePixelsInRect(labels,width,height,roi),34);
  assert.equal(canVerifyValidationRoi({...args,attested:false}).ok,false);
  assert.equal(canVerifyValidationRoi({...args,attested:true}).ok,true);
  assert.equal(canVerifyValidationRoi({...args,attested:true,
    rect:{...roi,verified:true}}).ok,false);
  assert.equal(canVerifyValidationRoi({...args,attested:true,
    rect:{...roi,evaluationRole:'training'}}).ok,false);
  assert.equal(canVerifyValidationRoi({...args,attested:true,minReferencePixels:40}).ok,false);
  assert.equal(canVerifyValidationRoi({...args,attested:true,
    abReviews:[{roi:{x:110,y:75,width:10,height:10}}]}).ok,false);
});
test('validation wizard and compact single-row A/B correction toolbar are wired to app',async()=>{
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const ui=await readFile(new URL('../src/local-ab-ui.js',import.meta.url),'utf8');
  const css=await readFile(new URL('../styles.css',import.meta.url),'utf8');
  for(const id of ['validationRoiStartButton','validationRoiResumeButton',
    'validationRoiSeedButton','validationRoiAttest','validationRoiFinishButton',
    'validationRoiPauseButton','validationRoiCancelSelectionButton']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(app,/verified:false, source:"validation-wizard-draft"/);
  assert.match(app,/canVerifyValidationRoi\(\{/);
  assert.match(app,/onStartValidation: \(\) => startValidationRoiWizard\(\)/);
  assert.match(ui,/local-ab-review-toolbar/);
  assert.match(ui,/data-k="startValidation"/);
  assert.match(css,/\.local-ab-manual \.local-ab-review-toolbar/);
  assert.ok(html.includes("v0.9.4-alpha"));
});

test('validation history map distinguishes A/B, manual review, previous ROIs and exclusions',()=>{
  const seen=validationUsageAreas(512,512,
    [{x0:0,y0:0,x1:99,y1:99}],
    [{roi:{x:100,y:100,width:128,height:128},imageFingerprint:'this-source'},
     {roi:{x:200,y:200,width:60,height:60},imageFingerprint:'other-source'}],
    [{x:320,y:200},{roi:{x:300,y:300,width:40,height:40}}],
    [{x0:420,y0:0,x1:480,y1:50}], 'this-source');
  assert.equal(seen.length,5);
  assert.deepEqual(seen.map(a=>a.kind),['existing','ab','manual','manual','excluded']);
  assert.deepEqual(seen[1],{x0:100,y0:100,x1:227,y1:227,kind:'ab'});
  assert.equal(seen[2].x0,315);
});

test('unused Validation ROI recommender avoids ALL stored activity and chooses largest available size',()=>{
  const ab=[{imageFingerprint:'bmp-1',roi:{x:0,y:0,width:256,height:256}}],
    old=[{x0:256,y0:0,x1:383,y1:127}],
    manual=[{roi:{x:0,y:350,width:100,height:100}}],
    excluded=[{x0:400,y0:300,x1:511,y1:511}];
  const args={width:512,height:512,existingRois:old,abReviews:ab,
    feedbackReviews:manual,exclusionRects:excluded,fingerprint:'bmp-1'};
  const suggestion=recommendUnusedValidationRoi(args);
  assert.ok(suggestion);
  for(const occupied of validationUsageAreas(512,512,old,ab,manual,excluded,'bmp-1')){
    assert.equal(roiOverlapPixels(occupied,suggestion),0);
  }
  assert.equal(validationRoiConflicts(suggestion,old,ab,-1,manual).ok,true);
});

test('unused ROI recommender safely reports none when all rectangles are blocked',()=>{
  assert.equal(recommendUnusedValidationRoi({
    width:200,height:200,existingRois:[{x0:0,y0:0,x1:199,y1:199}],
  }),null);
  assert.equal(recommendUnusedValidationRoi({width:50,height:50}),null);
});
test('recommended Validation map and canvas controls exist and run on actual selection',async()=>{
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../styles.css',import.meta.url),'utf8');
  for(const id of ['validationUsageCanvas','validationUsageMap','validationUsageToggle',
    'validationRoiRecommendButton','validationRoiUseRecommendationButton','validationUsageCounts']){
    assert.equal((html.match(new RegExp('id="'+id+'"','g'))??[]).length,1);
  }
  assert.match(app,/function renderValidationUsageView\(/);
  assert.match(app,/function createSuggestedValidationRoi\(/);
  assert.match(app,/validationRoiUseRecommendationButton"\)\.addEventListener/);
  assert.match(css,/#validationUsageCanvas \{ pointer-events:none;/);
});

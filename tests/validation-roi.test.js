import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  roiOverlapPixels, validationRoiConflicts,referencePixelsInRect,canVerifyValidationRoi,
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
  assert.match(html,/v0\.9\.2-alpha/);
});

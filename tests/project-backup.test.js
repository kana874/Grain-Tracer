import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createProjectExport,parseProjectFile,projectJsonChunks,backupName} from '../src/project-backup.js';
import {createProjectSnapshot,restoreReferenceMasks,PROJECT_VERSION} from '../src/project.js';

function makeProject(){
  const w=80,h=60,n=w*h;
  const ref=new Uint8Array(n),neg=new Uint8Array(n);
  ref[81]=1;ref[83]=1;neg[200]=1;
  return createProjectSnapshot({
    source:{name:'alloy.bmp',size:2345,width:500,height:400,bitDepth:24,fingerprint:'f-123'},
    preview:{width:w,height:h,scale:1},settings:{extraction:{sensitivity:88},autosaveEnabled:true},
    referenceMask:ref,referenceCenterline:ref,negativeMask:neg,
    manualNegativeMask:neg,negativeCenterline:neg,closedNegativeSeeds:[],
    exclusionRects:[{x0:0,y0:0,x1:5,y1:4}],
    fullEvaluationRois:[{x0:10,y0:11,x1:33,y1:34,evaluationRole:'training',verified:true}],
    feedbackReviews:[{id:'fb-1',kind:'positive',pixels:3}],
    localAbReviews:[{schema:'graintracer-preference-v2',winner:'b',roi:{x:20,y:10,width:20,height:20}}],
    preferenceAdoptions:[{accepted:true,before:{f1:.5},after:{f1:.6}}],
    baselineSnapshots:[{foo:'bar'}],history:[{name:'採用',details:'\\n"日本語\\t'.repeat(10)}],
  });
}

test('chunked JSON export roundtrips masks, histories, all current settings and special strings',async()=>{
  const project=makeProject();
  const output=await createProjectExport(project,'aluminum',{compressAboveBytes:Infinity});
  assert.match(output.filename,/\.graintracer\.json$/);
  assert.equal(output.compressed,false);
  const data=Object.assign(output.blob,{name:output.filename});
  const restored=await parseProjectFile(data);
  assert.deepEqual(restored,project);
  assert.equal(PROJECT_VERSION,4);
  assert.deepEqual(restoreReferenceMasks(restored).referenceCenterline,
    restoreReferenceMasks(project).referenceCenterline);
});

test('streaming serializer reproduces native JSON for nested dates, typed arrays and boundary strings',()=>{
  const payload={
    abc:[true,false,null,2,NaN,undefined,{a:'🙂'.repeat(2500),unicode:'𩸽'}],
    typed:new Uint16Array([1,256,65535]),time:new Date('2026-10-14T00:00:00Z'),
    giant:'hello\\n日本語\\t"'.repeat(10000),
  };
  const encoded=[...projectJsonChunks(payload,128)].join('');
  assert.deepEqual(JSON.parse(encoded),JSON.parse(JSON.stringify(payload)));
});

test('large archive can be parsed as gzip records without materializing one huge JSON string',async(t)=>{
  if(typeof CompressionStream==='undefined'||typeof DecompressionStream==='undefined'){
    t.skip('Compression streams not supported by this Node version');return;
  }
  const project=makeProject();
  project.history=Array.from({length:100},(_,i)=>({
    i,draw:'abc\\n"漢字'.repeat(80),tuning:{values:Array.from({length:260},(_,j)=>i+j)},
  }));
  project.classifier={weights:new Float32Array([1,2,3])};
  const output=await createProjectExport(project,'long-history',{compressAboveBytes:1});
  assert.match(output.filename,/\.graintracer\.archive\.gz$/);
  assert.equal(output.compressed,true);
  const original=JSON.parse([...projectJsonChunks(project)].join(''));
  const restored=await parseProjectFile(Object.assign(output.blob,{name:output.filename}));
  assert.deepEqual(restored,original);
  assert.equal(restored.history.length,100);
  assert.equal(restored.reference.centerline,project.reference.centerline);
});

test('string-sized stress fixture serializes in small parts and remains valid JSON',async()=>{
  const history=[{tuning:Array.from({length:170000},(_,i)=>({
    x:i,xy:'xy\\t"'.repeat(2),iteration:i%1000,
  }))}];
  const value={format:'graintracer-project',history,fullEvaluationRois:[]};
  let parts=0,max=0;
  for(const part of projectJsonChunks(value)){parts++;max=Math.max(max,part.length);}
  assert.ok(parts>10);
  assert.ok(max<140000);
});

test('backup generation does not modify the supplied snapshot or training vote data',async()=>{
  const old=makeProject(),before=JSON.stringify(old);
  const output=await createProjectExport(old,backupName('aluminum.bmp','backup'),{compressAboveBytes:Infinity});
  assert.ok(output.bytes>0);
  assert.equal(JSON.stringify(old),before);
  assert.equal(old.localAbReviews.length,1);
});

test('reset UI path requires explicit saved-file confirmation and bypasses autosave restore',async()=>{
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(app,/if\(state.pendingBackupReset\)/);
  assert.match(app,/window\.confirm\(/);
  assert.match(app,/await deleteAutosave\(fingerprint\)/);
  assert.match(app,/loadBmp\(file,\{skipAutosave:true\}\)/);
  assert.match(app,/if \(!skipAutosave && els\.autosaveEnabled\.checked\)/);
  assert.match(app,/parseProjectFile\(file\)/);
  assert.match(app,/backupNewSessionButton\.addEventListener/);
  assert.match(html,/id="backupNewSessionButton"/);
  assert.match(html,/accept="\.json,\.gz,/);
});

test('Unicode surrogate pairs remain intact when Blob encodes separate JSON chunks',async()=>{
  const source={magic:'𩸽',characters:'あ🙂𩸽'.repeat(5000),quote:'"\\t\\n'};
  const blob=new Blob([...projectJsonChunks(source,129)],{type:'application/json'});
  const restored=JSON.parse(await blob.text());
  assert.deepEqual(restored,source);
});

test('very long Unicode source metadata roundtrips a normal exported project file',async()=>{
  const project=makeProject();
  project.history.push({comment:'🌾'.repeat(90000)});
  const result=await createProjectExport(project,'emoji-large',{compressAboveBytes:Infinity});
  const loaded=await parseProjectFile(Object.assign(result.blob,{name:result.filename}));
  assert.equal(loaded.history.at(-1).comment,project.history.at(-1).comment);
});

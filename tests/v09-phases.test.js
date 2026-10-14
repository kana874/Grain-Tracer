import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildBoundaryMask } from '../src/analysis.js';
import { nextWheelZoom, zoomAroundCursor, dragViewport, eventToRoiPixel } from '../src/local-ab-viewport.js';
import { buildLocalPrediction, makeLocalFeaturePacket, cropLocalPrediction,
  materializeLocalPrediction, comparisonCacheKey, LruPredictionCache } from '../src/local-ab-engine.js';
import { aggregatePreferenceAcrossRois, evaluateManualLabelEvidence, summarizeValidationTrend } from '../src/local-ab-learning.js';
import { recommendFeatureRoi } from '../src/active-roi.js';

function synthFeatures(width=144,height=128){
  const n=width*height,gradient=new Uint8Array(n),zeros=new Uint8Array(n);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=y*width+x;
    gradient[p]=(x===35||x===36||y===60)?220:(x*7+y*11)%40;
  }
  return {width,height,dark:gradient,ridge:gradient,color:gradient,dendrite:gradient,
    dendriteLinePenalty:zeros,orientation:new Uint8Array(n),orientationAngle:new Float32Array(n),
    featureMargins:{dark:0,ridge:0,color:0,dendrite:0,dendriteLinePenalty:0},local:{enabled:false}};
}
const base={sensitivity:65,darkWeight:0,ridgeWeight:80,colorWeight:20,dendriteWeight:0,
  negativeEvidenceWeight:0,minComponent:2,centerlineNms:false,scoreMode:'legacy',edgeFrameGuard:0};

test('P1 zoom preserves pixel under mouse cursor and middle pan synchronizes scroll offsets',()=>{
  assert.ok(nextWheelZoom(2,-1)>2);
  assert.ok(nextWheelZoom(2,1)<2);
  assert.equal(nextWheelZoom(.25,1),.25);
  assert.equal(nextWheelZoom(8,-1),8);
  const input={scrollLeft:160,scrollTop:90,scale:2,
    clientX:450,clientY:230,viewportLeft:200,viewportTop:80};
  const changed=zoomAroundCursor(input,4);
  assert.equal((changed.scrollLeft+250)/4,(160+250)/2);
  assert.equal((changed.scrollTop+150)/4,(90+150)/2);
  assert.deepEqual(dragViewport({scrollLeft:300,scrollTop:100,x:40,y:50},
    {x:52,y:38}),{scrollLeft:288,scrollTop:112});
  const rect={left:100,top:50,width:1024,height:1024};
  assert.deepEqual(eventToRoiPixel(612,562,rect,256,256),{x:128,y:128});
  assert.deepEqual(eventToRoiPixel(100,50,rect,256,256),{x:0,y:0});
});

test('P2 halo ROI candidate equals entire preview mask at interior and edge on simple fixture',async()=>{
  const features=synthFeatures();
  const full=await buildBoundaryMask(features,base);
  for(const roi of [
    {x:20,y:20,width:48,height:48},
    {x:0,y:0,width:48,height:48},
    {x:96,y:80,width:48,height:48}
  ]){
    const local=await buildLocalPrediction(features,roi,base);
    assert.equal(local.mask.length,roi.width*roi.height);
    for(let y=0;y<roi.height;y++)for(let x=0;x<roi.width;x++){
      assert.equal(local.mask[y*roi.width+x],full[(roi.y+y)*features.width+roi.x+x],
        'Mismatch at '+JSON.stringify(roi)+' ['+x+','+y+']');
    }
    const sparse=materializeLocalPrediction(local.mask,roi,features.width,features.height);
    assert.equal(sparse.length,full.length);
    assert.equal(sparse[roi.y*features.width+roi.x],local.mask[0]);
  }
});
test('P2 ROI cache keys isolate mask revision, settings and ROI',()=>{
  const roi={x:0,y:0,width:64,height:64};
  const cache=new LruPredictionCache(2);
  const k1=comparisonCacheKey('fingerprint',roi,base,'feature-v1',1);
  const k2=comparisonCacheKey('fingerprint',{...roi,x:64},base,'feature-v1',1);
  const k3=comparisonCacheKey('fingerprint',roi,{...base,sensitivity:69},'feature-v1',1);
  assert.notEqual(k1,k2);assert.notEqual(k1,k3);
  cache.set(k1,new Uint8Array([1]));
  assert.equal(cache.get(k1)[0],1);
  cache.set(k2,new Uint8Array([2]));cache.set(k3,new Uint8Array([3]));
  assert.equal(cache.items.size,2);
  assert.equal(cache.get(k1),null);
  assert.equal(cache.hits,1);
});
test('P3 champion needs independent ROIs and cannot be hijacked by repeats',()=>{
  const proposed={...base,sensitivity:70};
  const vote=(winner,x,y)=>({
    schema:'graintracer-preference-v2',imageFingerprint:'img',algorithmVersion:'v18',
    featureOptions:{},aKey:'65|0|80|20|0|0|2|false|legacy',
    bKey:'70|0|80|20|0|0|2|false|legacy',roi:{x,y,width:64,height:64},
    winner,
  });
  let votes=[vote('b',0,0)];
  const opts={fingerprint:'img',algorithmVersion:'v18',featureOptions:{}};
  assert.equal(aggregatePreferenceAcrossRois(base,proposed,votes,opts).winner,null);
  votes.push(vote('b',0,0));
  assert.equal(aggregatePreferenceAcrossRois(base,proposed,votes,opts).distinctRois,1);
  votes.push(vote('b',300,0));
  assert.equal(aggregatePreferenceAcrossRois(base,proposed,votes,opts).winner,'b');
  votes.push(vote('a',400,200));
  assert.equal(aggregatePreferenceAcrossRois(base,proposed,votes,opts).winner,'b');
  votes.push({...vote('a',500,200),imageFingerprint:'test-img'});
  assert.equal(aggregatePreferenceAcrossRois(base,proposed,votes,opts).b,2);
});
test('P3 active ROI recommendation does not select held-out Validation/Test rectangle',()=>{
  const f=synthFeatures(256,256),unknown=new Uint8Array(256*256);
  const result=recommendFeatureRoi(f,base,{...base,sensitivity:76},128,{
    protectedRois:[{x0:0,y0:0,x1:127,y1:127,evaluationRole:'test',verified:true}],
    labelMask:unknown});
  assert.ok(result);
  assert.ok(result.roi.x>=128||result.roi.y>=128);
});
test('P4 manual evidence scores reviewed positives and negatives only',()=>{
  const w=10,h=10,a=new Uint8Array(w*h),b=new Uint8Array(w*h);
  const pos=new Uint8Array(w*h),neg=new Uint8Array(w*h);
  pos[2*w+3]=1;neg[3*w+3]=1;
  a[2*w+3]=1;a[3*w+3]=1;
  b[2*w+3]=1;
  const metrics=evaluateManualLabelEvidence(a,b,w,h,
    {x:0,y:0,width:10,height:10},pos,neg);
  assert.equal(metrics.labeled,2);
  assert.ok(metrics.scoreB>metrics.scoreA);
  assert.equal(metrics.unknownExcluded,true);
});
test('P5 standard mode hides legacy panels but retains Validation and A/B operations',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(html,/<body class="focus-mode">/);
  assert.match(html,/id="uiModeToggle"/);
  assert.match(html,/class="focus-primary"/);
  assert.match(html,/id="roiRoleSelect"/);
  assert.match(html,/id="localAbButton"/);
  assert.match(css,/\.focus-mode \.legacy-feature/);
  assert.match(html,/v0\.9\.0-alpha/);
});
test('P6 stress: 120 preferences and 120 cached ROI results remain bounded',()=>{
  const cache=new LruPredictionCache(10),votes=[];
  for(let i=0;i<120;i++){
    const roi={x:(i%10)*24,y:Math.floor(i/10)*18,width:64,height:64};
    const vote={schema:'graintracer-preference-v2',imageFingerprint:'img',
      algorithmVersion:'v18',featureOptions:{},
      aKey:'65|0|80|20|0|0|2|false|legacy',bKey:'70|0|80|20|0|0|2|false|legacy',
      roi,winner:i%4===0?'a':'b'};
    votes.push(vote);
    const key=comparisonCacheKey('img',roi,base,'f-v1',i%2);
    cache.set(key,new Uint8Array(roi.width*roi.height));
    cache.get(key);
    assert.ok(cache.items.size<=10);
  }
  assert.equal(votes.length,120);
  const aggregate=aggregatePreferenceAcrossRois(base,{...base,sensitivity:70},
    votes,{fingerprint:'img',algorithmVersion:'v18',featureOptions:{}});
  assert.ok(aggregate.distinctRois>2);
  assert.ok(JSON.stringify(votes).length<60000);
});

test('P5 Validation monitoring distinguishes improvement, stagnation and regression',()=>{
  const audit=(a,b,accepted)=>({before:{f1:a},after:{f1:b},accepted});
  assert.equal(summarizeValidationTrend([]).status,'未検証');
  assert.equal(summarizeValidationTrend([audit(.4,.48,true)]).status,'改善');
  assert.equal(summarizeValidationTrend([audit(.4,.401,false)]).status,'停滞');
  assert.equal(summarizeValidationTrend([audit(.48,.40,false)]).status,'悪化');
});
test('P6 stress actual ROI segmentation for 100 consecutive A/B rounds',async()=>{
  const features=synthFeatures(80,80),cache=new LruPredictionCache(10);
  let last=null,computed=0;
  for(let i=0;i<100;i++){
    const roi={x:i%2?0:28,y:i%3?0:25,width:32,height:32};
    const params={...base,sensitivity:65+(i%5)};
    const key=comparisonCacheKey('img',roi,params,'feature-stable');
    let mask=cache.get(key);
    if(!mask){
      mask=(await buildLocalPrediction(features,roi,params)).mask;
      cache.set(key,mask);
      computed++;
    }
    assert.equal(mask.length,roi.width*roi.height);
    assert.ok(cache.items.size<=10);
    last=mask;
  }
  assert.ok(computed<100,'cache avoids regenerating recurring ROI candidates');
  assert.equal(last.length,1024);
});

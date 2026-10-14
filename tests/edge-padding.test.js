import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorCoord, reflectPadRgba, cropPaddedFeatures } from '../src/edge-padding.js';
import { computeBoundaryFeatures, buildBoundaryMask, buildRawBoundaryMask } from '../src/analysis.js';

function syntheticLine(w = 48, h = 48, lineX = 2) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    const v = x === lineX ? 5 : 240;
    data[p] = data[p + 1] = data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('edge reflection maps out-of-bounds to valid mirrored source pixels', () => {
  assert.equal(mirrorCoord(-1, 5), 1);
  assert.equal(mirrorCoord(5, 5), 3);
  assert.equal(mirrorCoord(-3, 5), 3);
  assert.equal(mirrorCoord(0, 1), 0);
  const image = { width: 3, height: 1, data: Uint8ClampedArray.from([
    10,10,10,255, 20,20,20,255, 30,30,30,255,
  ]) };
  const padded = reflectPadRgba(image, 2);
  assert.equal(padded.width, 7);
  assert.equal(padded.height, 5);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(x => padded.data[(2 * padded.width + x) * 4]),
    [30,20,10,20,30,20,10]);
});

test('cropped feature dimensions and channels match source at every edge', () => {
  const padded = { width: 5, height: 5, ridge: Uint8Array.from({length:25}, (_,p)=>p),
    orientationAngle: Float32Array.from({length:25},(_,p)=>p*0.5),
    featureMargins: { ridge:5, color:7 }, local: {enabled:true} };
  const result = cropPaddedFeatures(padded,3,3,1);
  assert.deepEqual([...result.ridge], [6,7,8,11,12,13,16,17,18]);
  assert.equal(result.orientationAngle[0], 3);
  assert.deepEqual(result.featureMargins,{ridge:0,color:0});
  assert.equal(result.edgePaddingPixels,1);
});

test('real edge kernels recover Ridge evidence absent in old 5px feature margin', async () => {
  const image = syntheticLine();
  const settings = {localEnabled:false};
  const legacy = await computeBoundaryFeatures(image, {...settings,edgePadding:false});
  const fixed = await computeBoundaryFeatures(image, settings);
  const p = 20 * image.width + 2;
  assert.equal(legacy.ridge[p],0);
  assert.ok(fixed.ridge[p] > 40, 'reflected halo supplies genuine edge contrast');
  const options = {darkWeight:0,ridgeWeight:100,colorWeight:0,dendriteWeight:0,
    sensitivity:85,edgeFrameGuard:0,minComponent:1,centerlineNms:false};
  assert.equal(buildRawBoundaryMask(legacy,options)[p],0);
  assert.equal(buildRawBoundaryMask(fixed,options)[p],1);
});

test('supported boundary can reach true top frame; lone speck is still rejected', async () => {
  const w = 20, h = 20, n = w*h;
  const features = {width:w,height:h,dark:new Uint8Array(n),ridge:new Uint8Array(n),
    color:new Uint8Array(n),dendrite:new Uint8Array(n),
    orientation:new Uint8Array(n),orientationAngle:new Float32Array(n),
    featureMargins:{dark:0,ridge:0,color:0,dendrite:0}};
  for(let y=0;y<18;y++) features.ridge[y*w+10]=255;
  features.ridge[0]=255;
  const mask=await buildBoundaryMask(features,{sensitivity:85,darkWeight:0,ridgeWeight:100,
    colorWeight:0,dendriteWeight:0,minComponent:1,centerlineNms:false,edgeFrameGuard:0});
  assert.equal(mask[10],1,'legitimate continuation meets image frame');
  assert.equal(mask[0],0,'isolated border speck rejected');
});

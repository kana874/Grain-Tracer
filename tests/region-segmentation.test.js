import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentSeededRegions } from '../src/region-segmentation.js';

function fixture() {
  const width = 31, height = 21, ridge = new Float32Array(width * height);
  for (let y = 0; y < height; y++) ridge[y * width + 15] = 0.95;
  return { width, height, ridge, seeds: [{ x: 5, y: 10 }, { x: 25, y: 10 }] };
}

test('Seeded watershed places the inferred interface on image evidence', async () => {
  const f = fixture();
  const result = await segmentSeededRegions(f.width, f.height, f);
  assert.equal(result.summary.seedCount, 2);
  assert.ok(result.summary.supportedBoundaryPixels > 0);
  for (let p = 0; p < result.mask.length; p++) if (result.mask[p]) assert.equal(p % f.width, 15);
  assert.notEqual(result.labels[10 * f.width + 5], result.labels[10 * f.width + 25]);
  assert.equal(result.mask[15], 0);
});

test('Negative and exclusion protections block output boundaries', async () => {
  const f = fixture(), size = f.width * f.height;
  f.negativeMask = new Uint8Array(size);
  f.exclusionMask = new Uint8Array(size);
  f.negativeMask[10 * f.width + 15] = 1;
  for (let x = 0; x < f.width; x++) f.exclusionMask[4 * f.width + x] = 1;
  const result = await segmentSeededRegions(f.width, f.height, f);
  for (let p = 0; p < size; p++) if (f.exclusionMask[p]) {
    assert.equal(result.labels[p], 0); assert.equal(result.mask[p], 0);
  }
  for (let y = 9; y <= 11; y++) assert.equal(result.mask[y * f.width + 15], 0);
});

test('Seeds in the same annotated grain merge and insufficient independent seeds are rejected', async () => {
  const f = fixture(); f.closedNegativeMask = new Uint8Array(f.width * f.height);
  for (let x = 4; x <= 7; x++) f.closedNegativeMask[10 * f.width + x] = 1;
  f.seeds.push({ x: 6, y: 10 });
  const result = await segmentSeededRegions(f.width, f.height, f);
  assert.equal(result.summary.seedCount, 2);
  assert.equal(result.labels[10 * f.width + 5], result.labels[10 * f.width + 6]);
  await assert.rejects(segmentSeededRegions(f.width, f.height, { ...f, seeds: f.seeds.slice(0, 1) }), /2個以上/);
});

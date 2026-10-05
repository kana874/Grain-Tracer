import test from 'node:test';
import assert from 'node:assert/strict';
import { targetClosureSignature } from '../src/topology-repair.js';
import { computeClosureProfile } from '../src/topology.js';

function fixture() {
  const width = 64, height = 64;
  const boundary = new Uint8Array(width * height);
  const closed = new Uint8Array(boundary.length);
  for (let y = 8; y <= 55; y++) for (let x = 8; x <= 55; x++) {
    if (x === 8 || x === 55 || y === 8 || y === 55) boundary[y * width + x] = 1;
  }
  for (let y = 28; y <= 35; y++) for (let x = 28; x <= 35; x++) closed[y * width + x] = 1;
  return { width, height, boundary, closed, target: { seedP: 31 * width + 31, minX: 28, maxX: 35, minY: 28, maxY: 35 } };
}

test('Outer walls outside the old crop close the target at full-image coordinates', () => {
  const f = fixture();
  const options = { closedNegativeMask: f.closed };
  const target = targetClosureSignature(f.boundary, f.width, f.height, f.target, options);
  const global = computeClosureProfile(f.boundary, f.width, f.height, [], options);
  assert.equal(target.exactClosed, true);
  assert.equal(target.requiredRadius, 0);
  assert.equal(target.weightedClosureScore, global.weightedClosureScore);
  const tinyBox = { ...f.target, minX: 31, maxX: 31, minY: 31, maxY: 31 };
  assert.deepEqual(targetClosureSignature(f.boundary, f.width, f.height, tinyBox, options), target);
});

test('A true leak to the image edge remains open and an additive repair closes it', () => {
  const f = fixture();
  for (let x = 25; x <= 38; x++) f.boundary[8 * f.width + x] = 0;
  const options = { closedNegativeMask: f.closed };
  const before = targetClosureSignature(f.boundary, f.width, f.height, f.target, options);
  assert.equal(before.exactClosed, false);
  assert.equal(before.openAfterMaxRadius, 1);
  const additions = new Set(Array.from({ length: 14 }, (_, i) => 8 * f.width + 25 + i));
  const after = targetClosureSignature(f.boundary, f.width, f.height, f.target, options, additions);
  assert.equal(after.exactClosed, true);
  assert.equal(f.boundary[8 * f.width + 25], 0);
});

test('An annotation with no eligible eroded core is unmeasurable', () => {
  const f = fixture();
  const closed = new Uint8Array(f.closed.length);
  closed[f.target.seedP] = 1;
  const result = targetClosureSignature(f.boundary, f.width, f.height, f.target, { closedNegativeMask: closed });
  assert.equal(result.measurable, false);
  assert.equal(result.exactClosed, false);
});

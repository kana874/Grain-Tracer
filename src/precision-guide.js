export const PRECISION_GUIDE_VERSION = 2;
export const PRECISION_GUIDE_COLS = 8;
export const PRECISION_GUIDE_ROWS = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const keyOf = (rx, ry) => `${rx},${ry}`;
const chebyshev = (a, b) => Math.max(Math.abs(a.rx - b.rx), Math.abs(a.ry - b.ry));

export function hashString32(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seedFromFingerprint(fingerprint, salt = "precision-guide-v2") {
  return hashString32(`${fingerprint ?? ""}|${salt}`);
}

export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPrecisionGrid(width, height, cols = 8, rows = 8) {
  const cells = [];
  for (let ry = 0; ry < rows; ry += 1) {
    for (let rx = 0; rx < cols; rx += 1) {
      const x0 = Math.floor(rx * width / cols);
      const x1 = Math.floor((rx + 1) * width / cols);
      const y0 = Math.floor(ry * height / rows);
      const y1 = Math.floor((ry + 1) * height / rows);
      cells.push({
        rx, ry, x0, y0, x1, y1,
        width: Math.max(1, x1 - x0),
        height: Math.max(1, y1 - y0),
        area: Math.max(1, (x1 - x0) * (y1 - y0)),
      });
    }
  }
  return cells;
}

function roiCell(rect, width, height, cols, rows) {
  if (Number.isInteger(rect?.cellRx) && Number.isInteger(rect?.cellRy)
      && (rect.gridCols ?? cols) === cols && (rect.gridRows ?? rows) === rows) {
    return { rx: rect.cellRx, ry: rect.cellRy };
  }
  const cx = ((Number(rect?.x0) || 0) + (Number(rect?.x1) || 0)) / 2;
  const cy = ((Number(rect?.y0) || 0) + (Number(rect?.y1) || 0)) / 2;
  return {
    rx: clamp(Math.floor(cx / Math.max(1, width) * cols), 0, cols - 1),
    ry: clamp(Math.floor(cy / Math.max(1, height) * rows), 0, rows - 1),
  };
}

function occupiedCells(rois, width, height, cols, rows) {
  const cells = [];
  const keys = new Set();
  for (const rect of rois ?? []) {
    const cell = roiCell(rect, width, height, cols, rows);
    const key = keyOf(cell.rx, cell.ry);
    if (!keys.has(key)) cells.push(cell);
    keys.add(key);
  }
  return { cells, keys };
}

function exclusionRatio(cell, mask, width) {
  if (!mask) return 0;
  let count = 0;
  for (let y = cell.y0; y < cell.y1; y += 1) {
    const base = y * width;
    for (let x = cell.x0; x < cell.x1; x += 1) count += mask[base + x] ? 1 : 0;
  }
  return count / Math.max(1, cell.area);
}

function toRoi(cell, width, height, metadata = {}, cols = 8, rows = 8) {
  const targetWidth = Math.min(width, Math.max(140, Math.min(240, Math.round(cell.width * 0.85))));
  const targetHeight = Math.min(height, Math.max(100, Math.min(180, Math.round(cell.height * 0.85))));
  const cx = (cell.x0 + cell.x1 - 1) / 2;
  const cy = (cell.y0 + cell.y1 - 1) / 2;
  const x0 = clamp(Math.round(cx - targetWidth / 2), 0, Math.max(0, width - targetWidth));
  const y0 = clamp(Math.round(cy - targetHeight / 2), 0, Math.max(0, height - targetHeight));
  return {
    x0, y0,
    x1: Math.min(width - 1, x0 + targetWidth - 1),
    y1: Math.min(height - 1, y0 + targetHeight - 1),
    verified: false,
    source: "precision-guide",
    guideVersion: PRECISION_GUIDE_VERSION,
    gridCols: cols,
    gridRows: rows,
    cellRx: cell.rx,
    cellRy: cell.ry,
    suggestedAt: new Date().toISOString(),
    ...metadata,
  };
}

function deterministicShuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function selectBootstrapRois(options) {
  const {
    width, height, fingerprint, existingRois = [], exclusionMask = null,
    count = 3, cols = 8, rows = 8, suggestionRound = 0,
  } = options;
  const seed = seedFromFingerprint(fingerprint, `precision-bootstrap-v2|${suggestionRound}`);
  const random = createSeededRandom(seed);
  const occupied = occupiedCells(existingRois, width, height, cols, rows);
  const pool = deterministicShuffle(
    buildPrecisionGrid(width, height, cols, rows)
      .filter(cell => !occupied.keys.has(keyOf(cell.rx, cell.ry)))
      .filter(cell => exclusionRatio(cell, exclusionMask, width) < 0.60),
    random,
  );
  const selected = [];
  for (let pass = 0; pass < 2 && selected.length < count; pass += 1) {
    for (const cell of pool) {
      if (selected.some(item => item.rx === cell.rx && item.ry === cell.ry)) continue;
      if (pass === 0 && selected.some(item => chebyshev(item, cell) < 2)) continue;
      selected.push(cell);
      if (selected.length >= count) break;
    }
  }
  return selected.slice(0, count).map((cell, index) => toRoi(cell, width, height, {
    guideMode: "bootstrap",
    guideRole: "random-bootstrap",
    suggestionRound,
    selectionSeed: seed,
    selectionRank: index + 1,
    selectionScore: null,
    selectionMetrics: { deterministicRandom: true, minimumCellDistance: 2 },
  }, cols, rows));
}

export function selectReferenceGuidedRois(options) {
  const {
    width, height, regionalMetrics, existingRois = [], count = 3,
    cols = 8, rows = 8, minReferencePixels = 20, suggestionRound = 0,
  } = options;
  if (!regionalMetrics?.regions?.length) return [];
  const occupied = occupiedCells(existingRois, width, height, cols, rows);
  const usable = regionalMetrics.regions
    .filter(region => region.referencePixels >= minReferencePixels)
    .filter(region => !occupied.keys.has(keyOf(region.rx, region.ry)));
  if (!usable.length) return [];
  const selected = [];
  const add = (region, role) => {
    if (!region || selected.some(item => item.region.rx === region.rx && item.region.ry === region.ry)) return;
    selected.push({ region, role });
  };
  add([...usable].sort((a, b) => a.positiveRecall - b.positiveRecall)[0], "low-recall");
  add([...usable].filter(r => r.negativePixels > 0).sort((a, b) => b.negativeLeakage - a.negativeLeakage)[0], "high-leakage");
  add([...usable].sort((a, b) => {
    const da = Math.abs(a.positiveRecall - regionalMetrics.positiveRecall)
      + Math.abs(a.negativeLeakage - regionalMetrics.negativeLeakage);
    const db = Math.abs(b.positiveRecall - regionalMetrics.positiveRecall)
      + Math.abs(b.negativeLeakage - regionalMetrics.negativeLeakage);
    return da - db;
  })[0], "representative");
  for (const region of [...usable].sort((a, b) => b.referencePixels - a.referencePixels)) {
    if (selected.length >= count) break;
    add(region, "representative");
  }
  return selected.slice(0, count).map(({ region, role }, index) => toRoi(region, width, height, {
    guideMode: "bootstrap-informed",
    guideRole: role,
    suggestionRound,
    selectionRank: index + 1,
    selectionScore: null,
    selectionMetrics: {
      positiveRecall: region.positiveRecall,
      negativeLeakage: region.negativeLeakage,
      referencePixels: region.referencePixels,
    },
  }, cols, rows));
}

function localRisk(region, calibration) {
  if (!calibration?.values?.length || !calibration.cols || !calibration.rows) return 0;
  const lx = clamp(Math.floor(((region.rx + 0.5) / 8) * calibration.cols), 0, calibration.cols - 1);
  const ly = clamp(Math.floor(((region.ry + 0.5) / 8) * calibration.rows), 0, calibration.rows - 1);
  return Math.abs(Number(calibration.values[ly * calibration.cols + lx]) || 0);
}

function minDistance(cell, cells) {
  return cells.length ? Math.min(...cells.map(other => chebyshev(cell, other))) : 8;
}

export function selectActiveRois(options) {
  const {
    width, height, regionalMetrics, existingRois = [], localCalibration = null,
    count = 3, cols = 8, rows = 8, suggestionRound = 1,
    guardRollback = false, maxVerifiedRois = 9,
  } = options;
  if (!regionalMetrics?.regions?.length) return [];
  const verifiedCount = existingRois.filter(rect => rect?.verified !== false).length;
  if (verifiedCount >= maxVerifiedRois) return [];
  const occupied = occupiedCells(existingRois, width, height, cols, rows);
  const globalRecall = regionalMetrics.positiveRecall ?? 0;
  const macroLeak = regionalMetrics.macroNegativeLeakage ?? regionalMetrics.negativeLeakage ?? 0;
  const candidates = [];

  for (const region of regionalMetrics.regions) {
    if (occupied.keys.has(keyOf(region.rx, region.ry))) continue;
    const area = Math.max(1, (region.x1 - region.x0) * (region.y1 - region.y0));
    if ((region.excludedPixels ?? 0) / area >= 0.60) continue;
    const predictionPixels = region.predictionPixels
      ?? ((region.matchedPrediction ?? 0) + (region.negativePrediction ?? 0) + (region.unknownPrediction ?? 0));
    const predictionDensity = predictionPixels / area;
    const referenceDensity = (region.referencePixels ?? 0) / area;
    const excess = predictionDensity - referenceDensity * 1.35;
    const recallGap = region.referencePixels >= 20 ? Math.max(0, globalRecall - region.positiveRecall) : 0;
    const leakGap = region.negativePixels >= 20 ? Math.max(0, region.negativeLeakage - macroLeak) : 0;
    const risk = localRisk(region, localCalibration);
    const distance = minDistance(region, occupied.cells);
    const coverageTrigger = verifiedCount < 6 && distance >= 3;
    const triggered = recallGap > 0.05
      || leakGap > 0.03
      || (predictionDensity > 0.015 && excess > 0.008)
      || risk >= 3
      || coverageTrigger;
    if (!triggered) continue;

    const parts = {
      lowRecall: clamp((recallGap - 0.05) / 0.20, 0, 1),
      highLeakage: clamp((leakGap - 0.03) / 0.20, 0, 1),
      fpSuspect: clamp((excess - 0.008) / 0.05, 0, 1),
      localRisk: clamp((risk - 3) / 12, 0, 1),
      coverage: coverageTrigger ? clamp((distance - 1) / 4, 0, 1) : 0,
    };
    const role = [
      ["low-recall", parts.lowRecall],
      ["high-leakage", parts.highLeakage],
      ["fp-suspect", parts.fpSuspect],
      ["local-risk", parts.localRisk],
      ["coverage", parts.coverage],
    ].sort((a, b) => b[1] - a[1])[0][0];
    const score = parts.lowRecall * 0.30 + parts.highLeakage * 0.25
      + parts.fpSuspect * 0.25 + parts.localRisk * 0.12 + parts.coverage * 0.08
      + (guardRollback ? 0.08 : 0);
    candidates.push({
      region, role, score,
      metrics: {
        positiveRecall: region.positiveRecall,
        globalPositiveRecall: globalRecall,
        recallGap,
        negativeLeakage: region.negativeLeakage,
        macroNegativeLeakage: macroLeak,
        leakageGap: leakGap,
        predictionPixels,
        predictionDensity,
        referencePixels: region.referencePixels,
        referenceDensity,
        predictionExcess: excess,
        localRisk: risk,
        distanceFromVerifiedCell: distance,
        guardRollback,
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (let pass = 0; pass < 2 && selected.length < count; pass += 1) {
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      if (pass === 0 && selected.some(item => chebyshev(item.region, candidate.region) < 2)) continue;
      selected.push(candidate);
      if (selected.length >= count) break;
    }
  }

  return selected.slice(0, count).map((candidate, index) => toRoi(candidate.region, width, height, {
    guideMode: "active",
    guideRole: candidate.role,
    suggestionRound,
    selectionRank: index + 1,
    selectionScore: candidate.score,
    selectionMetrics: candidate.metrics,
  }, cols, rows));
}

export function precisionGuideCoverage(rois, width, height, cols = 8, rows = 8) {
  const verified = (rois ?? []).filter(rect => rect?.verified !== false);
  const occupied = occupiedCells(verified, width, height, cols, rows);
  return {
    cols,
    rows,
    verifiedRoiCount: verified.length,
    coveredCellCount: occupied.keys.size,
    coverageRatio: occupied.keys.size / Math.max(1, cols * rows),
    coveredCells: occupied.cells,
  };
}

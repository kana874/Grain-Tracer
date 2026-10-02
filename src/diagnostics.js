import {
  computeFullEvaluationRoiMetrics,
  computeMultiToleranceMetrics,
  computeRegionalMetrics,
  splitReferenceCenterline,
} from "./evaluation.js";

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function summarizeValues(values) {
  if (!values.length) {
    return { count: 0, mean: 0, std: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  }
  values.sort((a, b) => a - b);
  let sum = 0;
  let sumSq = 0;
  for (const value of values) {
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / values.length;
  const variance = Math.max(0, sumSq / values.length - mean * mean);
  return {
    count: values.length,
    mean,
    std: Math.sqrt(variance),
    p10: quantile(values, 0.10),
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.50),
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.90),
  };
}

function featureStatistics(features, selector) {
  const result = {};
  for (const name of ["dark", "ridge", "color", "dendrite"]) {
    const source = features[name];
    if (!source) continue;
    const values = [];
    for (let p = 0; p < selector.length; p += 1) {
      if (selector[p]) values.push(source[p] / 255);
    }
    result[name] = summarizeValues(values);
  }
  return result;
}

function buildErrorMasks(prediction, referenceCenterline, width, height, options) {
  const metrics = computeRegionalMetrics(
    prediction,
    referenceCenterline,
    width,
    height,
    {
      ...options,
      cols: 4,
      rows: 4,
    },
  );
  const tp = new Uint8Array(prediction.length);
  const fp = new Uint8Array(prediction.length);
  const fn = new Uint8Array(prediction.length);
  const negativeViolation = new Uint8Array(prediction.length);
  const unknownPrediction = new Uint8Array(prediction.length);

  for (let p = 0; p < prediction.length; p += 1) {
    if (metrics.exclusionMask?.[p]) continue;
    if (prediction[p] && metrics.evaluationMask[p]) {
      if (metrics.referenceTolerance[p]) {
        tp[p] = 1;
      } else {
        fp[p] = 1;
        if (metrics.negativeMask?.[p]) negativeViolation[p] = 1;
      }
    } else if (prediction[p] && metrics.unknownMask?.[p]) {
      unknownPrediction[p] = 1;
    }
    if (referenceCenterline[p] && !metrics.predictionTolerance[p]) fn[p] = 1;
  }
  return { tp, fp, fn, negativeViolation, unknownPrediction, metrics };
}

function hotspotComponents(mask, width, height, features, type, limit = 16) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let dark = 0;
    let ridge = 0;
    let color = 0;
    let dendrite = 0;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      dark += features.dark[p] / 255;
      ridge += features.ridge[p] / 255;
      color += features.color[p] / 255;
      dendrite += (features.dendrite?.[p] ?? 0) / 255;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (mask[np] && !visited[np]) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    }

    components.push({
      type,
      pixels: tail,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      meanFeatures: {
        dark: dark / tail,
        ridge: ridge / tail,
        color: color / tail,
        dendrite: dendrite / tail,
      },
    });
  }

  components.sort((a, b) => b.pixels - a.pixels);
  return components.slice(0, limit);
}

function regionFeatureSummary(features, width, region) {
  let count = 0;
  let dark = 0;
  let ridge = 0;
  let color = 0;
  let dendrite = 0;
  for (let y = region.y0; y < region.y1; y += 1) {
    const base = y * width;
    for (let x = region.x0; x < region.x1; x += 1) {
      const p = base + x;
      count += 1;
      dark += features.dark[p] / 255;
      ridge += features.ridge[p] / 255;
      color += features.color[p] / 255;
      dendrite += (features.dendrite?.[p] ?? 0) / 255;
    }
  }
  const den = Math.max(1, count);
  return {
    darkMean: dark / den,
    ridgeMean: ridge / den,
    colorMean: color / den,
    dendriteMean: dendrite / den,
  };
}

function compactHistory(history) {
  return (history ?? []).slice(-40).map(item => ({
    timestamp: item.timestamp,
    kind: item.kind,
    algorithmVersion: item.algorithmVersion,
    parameters: item.parameters,
    local: item.local,
    localCalibration: item.localCalibration,
    tuning: item.tuning ?? null,
    metrics: item.metrics ? {
      evaluationMode: item.metrics.evaluationMode ?? "partial-label",
      positiveRecall: item.metrics.positiveRecall ?? item.metrics.recall ?? 0,
      negativeLeakage: item.metrics.negativeLeakage ?? item.metrics.negativeHitRate ?? 0,
      alignmentError: item.metrics.alignmentError ?? null,
      labelPrecisionProxy: item.metrics.labelPrecisionProxy ?? item.metrics.precision ?? 0,
      labelF1Proxy: item.metrics.labelF1Proxy ?? item.metrics.f1 ?? 0,
      matchedPrediction: item.metrics.matchedPrediction,
      falsePositive: item.metrics.falsePositive,
      unknownPrediction: item.metrics.unknownPrediction ?? 0,
      matchedReference: item.metrics.matchedReference,
      falseNegative: item.metrics.falseNegative,
      negativePrediction: item.metrics.negativePrediction ?? 0,
      negativePixels: item.metrics.negativePixels ?? 0,
      excludedPixels: item.metrics.excludedPixels ?? 0,
    } : null,
    note: item.note ?? "",
  }));
}

export function buildDiagnosticReport(input) {
  const {
    source,
    preview,
    settings,
    features,
    prediction,
    referenceCenterline,
    negativeMask,
    negativeCenterline,
    closedNegativeMask,
    borderAssistedNegativeMask,
    closedNegativeSeeds,
    negativeHoldout,
    exclusionMask,
    exclusionRects,
    fullEvaluationRois,
    precisionGuide,
    localCalibration,
    history,
    performance,
    topology,
    gapBridge,
    algorithmVersion,
    appVersion,
  } = input;

  const comparison = settings.comparison;
  const metrics = computeRegionalMetrics(
    prediction,
    referenceCenterline,
    preview.width,
    preview.height,
    {
      tolerance: comparison.tolerance,
      reviewRadius: comparison.reviewRadius,
      negativeMask,
      exclusionMask,
      cols: 4,
      rows: 4,
    },
  );
  const masks = buildErrorMasks(
    prediction,
    referenceCenterline,
    preview.width,
    preview.height,
    {
      ...comparison,
      negativeMask,
      exclusionMask,
    },
  );

  const multiTolerance = computeMultiToleranceMetrics(
    prediction,
    referenceCenterline,
    preview.width,
    preview.height,
    {
      tolerances: [1, 2, 3, 4],
      reviewRadius: comparison.reviewRadius,
      negativeMask,
      exclusionMask,
    },
  );
  const verifiedFullEvaluationRois = (fullEvaluationRois ?? []).filter(rect => rect?.verified !== false);
  const provisionalFullEvaluationRois = (fullEvaluationRois ?? []).filter(rect => rect?.verified === false);
  const fullEvaluationRoi = computeFullEvaluationRoiMetrics(
    prediction,
    referenceCenterline,
    preview.width,
    preview.height,
    verifiedFullEvaluationRois,
    {
      tolerance: comparison.tolerance,
      exclusionMask,
    },
  );

  const regionsWithReference = metrics.regions.filter(region => region.referencePixels > 0);
  const macroRegionF1 = regionsWithReference.length
    ? regionsWithReference.reduce((sum, region) => sum + region.f1, 0) / regionsWithReference.length
    : 0;

  const split = splitReferenceCenterline(
    referenceCenterline,
    preview.width,
    preview.height,
    { validationFraction: 0.20, minComponentPixels: 8, strategy: "spatial-balanced", cols: 4, rows: 4 },
  );
  const negativeSplit = negativeHoldout ?? null;
  const tuningNegativeMask = negativeSplit?.tuningMask ?? negativeMask;
  const validationNegativeMask = negativeSplit?.validationMask ?? null;
  const tuningMetrics = computeRegionalMetrics(
    prediction,
    split.tuneMask,
    preview.width,
    preview.height,
    {
      tolerance: comparison.tolerance,
      reviewRadius: comparison.reviewRadius,
      negativeMask: tuningNegativeMask,
      exclusionMask,
      cols: 4,
      rows: 4,
    },
  );
  const validationMetrics = split.validationPixels > 0
    ? computeRegionalMetrics(
      prediction,
      split.validationMask,
      preview.width,
      preview.height,
      {
        tolerance: comparison.tolerance,
        reviewRadius: comparison.reviewRadius,
        negativeMask: validationNegativeMask,
        exclusionMask,
        cols: 4,
        rows: 4,
      },
    )
    : null;

  const regions = metrics.regions.map(region => ({
    rx: region.rx,
    ry: region.ry,
    x0: region.x0,
    y0: region.y0,
    x1: region.x1,
    y1: region.y1,
    referencePixels: region.referencePixels,
    matchedReference: region.matchedReference ?? 0,
    falseNegative: region.falseNegative ?? 0,
    positiveRecall: region.positiveRecall ?? region.recall,
    negativePixels: region.negativePixels ?? 0,
    negativePrediction: region.negativePrediction ?? 0,
    negativeLeakage: region.negativeLeakage ?? region.negativeHitRate ?? 0,
    unknownPrediction: region.unknownPrediction ?? 0,
    matchedPrediction: region.matchedPrediction ?? 0,
    predictionPixels: region.predictionPixels ?? 0,
    alignmentError: region.alignmentError ?? null,
    excludedPixels: region.excludedPixels ?? 0,
    labelPrecisionProxy: region.labelPrecision ?? region.precision,
    labelF1Proxy: region.labelF1 ?? region.f1,
    ...regionFeatureSummary(features, preview.width, region),
  }));

  return {
    schema: "graintracer-diagnostic-v14",
    generatedAt: new Date().toISOString(),
    appVersion,
    algorithmVersion,
    source,
    preview: {
      width: preview.width,
      height: preview.height,
      scale: preview.scale,
    },
    settings,
    algorithmInternals: {
      ridgeScales: [1, 2, 4],
      colorSampleDistances: [2, 4, 6],
      dendriteTensorRadius: 7,
      dendriteSampleDistances: [5, 9, 13],
      neighborSupportMinimum: 2,
      edgeAwareFeatureRenormalization: true,
      edgeFrameGuard: 1,
      centerlineNms: settings.extraction?.centerlineNms !== false,
      centerlineNmsMode: "continuous-ridge-normal-bilinear-non-maximum-suppression",
      ridgeOrientationMode: "axial-double-angle-interpolated",
      featureMargins: features.featureMargins ?? {
        dark: 0,
        ridge: 5,
        color: 7,
        dendrite: 14,
      },
      localCalibrationGrid: "4x4",
      localCalibrationObjective: "partial-label-plus-verified-roi-when-available",
      localCalibrationPolicy: "v2.1-measured-zero-anchor-adjacent-only-propagation-regional-recall-guard",
      localCalibrationMaxRegionalRecallDrop: 0.02,
      localCalibrationPropagationRadiusCells: Math.SQRT2,
      precisionGuideVersion: 2,
      precisionGuideGrid: "8x8",
      precisionGuideBootstrap: "deterministic-fingerprint-seeded-3-roi",
      precisionGuideActiveSelection: "low-recall-high-leakage-prediction-excess-local-risk-spatial-novelty",
      diagnosticBundleSchema: "graintracer-diagnostic-bundle-v1",
      oneClickStageDiagnostics: true,
    },
    precisionGuide: precisionGuide ?? null,
    localCalibration: localCalibration ?? null,
    performance: {
      featureComputeMs: performance?.featureComputeMs ?? null,
      boundaryAnalysisMs: performance?.boundaryAnalysisMs ?? null,
      comparisonMs: performance?.comparisonMs ?? null,
      autoTuneMs: performance?.autoTuneMs ?? null,
      autoOptimizeMs: performance?.autoOptimizeMs ?? null,
      closedFillRebuildMs: performance?.closedFillRebuildMs ?? null,
      annotationCommitMs: performance?.annotationCommitMs ?? null,
      autosaveSerializeMs: performance?.autosaveSerializeMs ?? null,
      autosaveWriteMs: performance?.autosaveWriteMs ?? null,
      topologyMs: performance?.topologyMs ?? null,
      gapBridgeMs: performance?.gapBridgeMs ?? null,
      previewPixels: performance?.previewPixels ?? (preview.width * preview.height),
      closedFillSeedCount: performance?.closedFillSeedCount ?? (closedNegativeSeeds ?? []).length,
      borderAssistedFillSeedCount: performance?.borderAssistedFillSeedCount
        ?? (closedNegativeSeeds ?? []).filter(seed => seed?.borderAssisted).length,
      note: "Latest measured duration per operation in this browser session; null means not measured yet.",
    },
    evaluation: {
      mode: "partial-label",
      positiveRecall: metrics.positiveRecall,
      negativeLeakage: metrics.negativeLeakage,
      macroNegativeLeakage: metrics.macroNegativeLeakage,
      negativeRegionCount: metrics.negativeRegionCount,
      maxNegativeRegionShare: metrics.maxNegativeRegionShare,
      alignmentError: metrics.alignmentError,
      matchedReference: metrics.matchedReference,
      falseNegative: metrics.falseNegative,
      negativePrediction: metrics.negativePrediction,
      negativePixels: metrics.negativePixels,
      unknownPrediction: metrics.unknownPrediction,
      excludedPixels: metrics.excludedPixels,
      labelProxy: {
        precision: metrics.labelPrecision,
        recall: metrics.positiveRecall,
        f1: metrics.labelF1,
        macroRegionF1,
        note: "Proxy score over labelled Positive/Negative areas only; not whole-image Precision/F1.",
      },
      multiTolerance,
      fullEvaluationRoi,
      tuning: {
        positiveRecall: tuningMetrics.positiveRecall,
        negativeLeakage: tuningMetrics.negativeLeakage,
        macroNegativeLeakage: tuningMetrics.macroNegativeLeakage,
        negativeRegionCount: tuningMetrics.negativeRegionCount,
        alignmentError: tuningMetrics.alignmentError,
        labelPrecisionProxy: tuningMetrics.labelPrecision,
        labelF1Proxy: tuningMetrics.labelF1,
      },
      validation: validationMetrics ? {
        positiveRecall: validationMetrics.positiveRecall,
        negativeLeakage: validationMetrics.negativeLeakage,
        macroNegativeLeakage: validationMetrics.macroNegativeLeakage,
        negativeRegionCount: validationMetrics.negativeRegionCount,
        alignmentError: validationMetrics.alignmentError,
        labelPrecisionProxy: validationMetrics.labelPrecision,
        labelF1Proxy: validationMetrics.labelF1,
      } : null,
    },
    validationSplit: {
      mode: split.mode,
      componentCount: split.componentCount,
      tuningPixels: split.tuningPixels,
      validationPixels: split.validationPixels,
      validationFraction: split.validationFraction,
      requestedValidationFraction: split.requestedValidationFraction ?? 0.20,
      grid: split.cols && split.rows ? { cols: split.cols, rows: split.rows } : null,
      tuningCellCount: split.tuningCellCount ?? null,
      validationCellCount: split.validationCellCount ?? null,
      negative: negativeSplit ? {
        mode: negativeSplit.mode ?? "independent-region-holdout",
        tuningPixels: negativeSplit.tuningPixels ?? 0,
        validationPixels: negativeSplit.validationPixels ?? 0,
        validationFraction: (negativeSplit.validationPixels ?? 0)
          / Math.max(1, (negativeSplit.tuningPixels ?? 0) + (negativeSplit.validationPixels ?? 0)),
        manualComponentCount: negativeSplit.summary?.manualComponentCount ?? negativeSplit.manualSplit?.componentCount ?? 0,
        closedRegionCount: negativeSplit.summary?.closedRegionCount ?? negativeSplit.closedSplit?.regionCount ?? 0,
        closedTuningRegionCount: negativeSplit.summary?.closedTuningRegionCount ?? negativeSplit.closedSplit?.tuningRegionCount ?? 0,
        closedValidationRegionCount: negativeSplit.summary?.closedValidationRegionCount ?? negativeSplit.closedSplit?.validationRegionCount ?? 0,
        closedTuningPixels: negativeSplit.summary?.closedTuningPixels ?? negativeSplit.closedSplit?.tuningPixels ?? 0,
        closedValidationPixels: negativeSplit.summary?.closedValidationPixels ?? negativeSplit.closedSplit?.validationPixels ?? 0,
      } : null,
    },
    topology: topology ?? null,
    postProcessing: {
      gapBridge: gapBridge ?? null,
      safeGapBridge: gapBridge && ((gapBridge.safeBridgeCount ?? 0) > 0 || gapBridge.mode === "safe")
        ? {
          bridgeCount: gapBridge.safeBridgeCount ?? gapBridge.bridgeCount ?? 0,
          applications: (gapBridge.applications ?? []).filter(item => item.mode === "safe"),
        }
        : null,
      extendedGapBridge: gapBridge && ((gapBridge.extendedBridgeCount ?? 0) > 0 || gapBridge.mode === "extended")
        ? {
          bridgeCount: gapBridge.extendedBridgeCount ?? gapBridge.bridgeCount ?? 0,
          applications: (gapBridge.applications ?? []).filter(item => item.mode === "extended"),
        }
        : null,
      topologyDifference: gapBridge ? {
        before: gapBridge.topologyBefore ?? gapBridge.applications?.[0]?.topology?.before ?? null,
        after: gapBridge.topologyAfter
          ?? gapBridge.applications?.[gapBridge.applications.length - 1]?.topology?.after
          ?? null,
        delta: gapBridge.topologyDelta ?? null,
      } : null,
    },
    referenceCoverage: {
      regionsWithReference: regionsWithReference.length,
      totalRegions: metrics.regions.length,
      referencePixels: metrics.referencePixels,
      labelledPredictionPixels: metrics.reviewedPredictionPixels,
      unknownPredictionPixels: metrics.unknownPrediction,
      nonBoundaryPixels: metrics.negativePixels,
      nonBoundaryPredictionPixels: metrics.negativePrediction,
      negativeRegionCount: metrics.negativeRegionCount,
      macroNegativeLeakage: metrics.macroNegativeLeakage,
      maxNegativeRegionShare: metrics.maxNegativeRegionShare,
      exclusionRectCount: (exclusionRects ?? []).length,
      excludedPixels: metrics.excludedPixels,
      fullEvaluationRoiCount: verifiedFullEvaluationRois.length,
      provisionalFullEvaluationRoiCount: provisionalFullEvaluationRois.length,
      fullEvaluationRoiPixels: fullEvaluationRoi.roiPixels,
    },
    featureStatistics: {
      truePositive: featureStatistics(features, masks.tp),
      explicitNegativeViolation: featureStatistics(features, masks.fp),
      falseNegative: featureStatistics(features, masks.fn),
      unknownPrediction: featureStatistics(features, masks.unknownPrediction),
      nonBoundaryReference: negativeMask ? featureStatistics(features, negativeMask) : {},
      nonBoundaryViolation: featureStatistics(features, masks.negativeViolation),
    },
    annotations: {
      nonBoundaryCenterlinePixels: negativeCenterline
        ? negativeCenterline.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
      closedNegativeFillSeeds: (closedNegativeSeeds ?? []).map(seed => ({ ...seed })),
      closedNegativeFillSeedCount: (closedNegativeSeeds ?? []).length,
      closedNegativeFillPixels: closedNegativeMask
        ? closedNegativeMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
      borderAssistedFillSeedCount: (closedNegativeSeeds ?? []).filter(seed => seed?.borderAssisted).length,
      borderAssistedFillPixels: borderAssistedNegativeMask
        ? borderAssistedNegativeMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
      nonBoundaryMaskPixels: negativeMask
        ? negativeMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
      exclusionRects: (exclusionRects ?? []).map(rect => ({ ...rect })),
      fullEvaluationRois: (fullEvaluationRois ?? []).map(rect => ({ ...rect })),
      verifiedFullEvaluationRoiCount: verifiedFullEvaluationRois.length,
      provisionalFullEvaluationRoiCount: provisionalFullEvaluationRois.length,
      excludedPixels: exclusionMask
        ? exclusionMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
    },
    regions,
    hotspots: [
      ...hotspotComponents(masks.fp, preview.width, preview.height, features, "explicitNegativeViolation"),
      ...hotspotComponents(masks.fn, preview.width, preview.height, features, "falseNegative"),
      ...hotspotComponents(masks.negativeViolation, preview.width, preview.height, features, "nonBoundaryViolation"),
    ].sort((a, b) => b.pixels - a.pixels).slice(0, 24),
    tuningTrace: compactHistory(history),
    notes: [
      "Feature values are normalized to 0..1.",
      "Near image edges, extraction renormalizes the score over feature channels that are geometrically available; the outermost 1 px remains guarded to suppress image-frame artifacts.",
      "Topology v3.0 adds a Minimum Closure Radius profile over 0/1/2/3 px probes so topology improvement can be measured even when exact 0 px closure remains zero.",
      "Precision Guide v2 uses an 8x8 candidate grid. With no Positive reference, three spatially separated ROI candidates are selected deterministically from the source fingerprint; later rounds use active selection from Recall, Negative Leakage, prediction excess, Local risk, and spatial novelty.",
      "Guided precision-evaluation ROI suggestions remain provisional until the user explicitly confirms that every visible boundary inside the ROI has been labelled; only verified ROIs contribute formal True Precision / Recall / F1.",
      "Extended Gap evaluates paths beyond the Safe Gap distance up to 8 preview pixels and requires Ridge/Color path evidence; it is preview-only until the user explicitly applies the displayed proposal.",
      "Gap post-processing stores before/after closure snapshots and closed-region/closure-rate deltas in diagnostic JSON.",
      "Evaluation mode is Partial Label: Positive=boundary, Negative=non-boundary, Unknown=unlabelled.",
      "Predictions in Unknown areas are not counted as false positives.",
      "Positive Recall measures how much of the user-labelled boundary centerline is recovered.",
      "Positive tuning/validation holdout uses a deterministic 4x4 spatial grid and selects validation cells to keep labelled-pixel fraction close to 20%, reducing oversized connected-component bias.",
      "Negative Leakage is pixel-weighted over explicit non-boundary labels.",
      "Macro Negative Leakage is the unweighted mean leakage across 4x4 regions that contain Negative labels and is used by Auto Tune v2 in Partial Label mode.",
      "Closed-region Negative Fill is regenerated from saved seed coordinates and the current positive reference geometry. Seeds may explicitly preserve border-assisted image-frame closure.",
      "Closed-region Negative Fill holdout is split by whole connected grain-interior regions; a region never contributes pixels to both tuning and validation.",
      "Centerline NMS uses a continuous axial Ridge-normal estimate and bilinear score samples to suppress non-maximal responses before connected-component filtering when enabled.",
      "Auto Tune v2 search trace v4 keeps fast raw scoring for proposal generation and processed acceptance. One-click Optimization keeps that coordinate objective unchanged, then uses the Topology v3 closure profile as a conservative post-processing guard for automatic Gap repair.",
      "Local Calibration v2.1 keeps measured zero-delta cells as hard global-sensitivity anchors, limits interpolation to unmeasured adjacent cells, adds finer near-zero sensitivity candidates, and rejects local candidates whose regional Recall falls more than 2 percentage points below the local baseline.",
      "Verified complete-evaluation ROI pixels remain true foreground/background supervision while Partial Label semantics are preserved outside verified ROIs.",
      "Diagnostic ZIP bundle v1 packages manifest.json, diagnostic.json, preview, comparison, Ridge, Dendrite, reference, non-boundary, exclusion, and full-ROI images in one dependency-free ZIP32 STORE archive.",
      "One-click tuning history records Global and Local stage status as accepted, no-change, or rolled-back together with a machine-readable reason and local candidate diagnostics.",
      "Performance timings are the latest browser-session measurements in milliseconds and are intended for regression diagnosis rather than cross-device benchmarking.",
      "Whole-image Precision/F1 are not formal metrics in Partial Label mode.",
      "True Precision / Recall / F1 are reported only inside complete-evaluation ROIs.",
      "Multi-Tolerance diagnostics are reported for 1, 2, 3, and 4 preview pixels.",
      "Exclusion rectangles are removed from both boundary output and evaluation.",
      "Dendrite statistics represent cross-boundary orientation/coherence change estimated from a local structure tensor.",
    ],
  };
}

export function featureMapImageData(feature, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < feature.length; p += 1) {
    const value = feature[p];
    const i = p * 4;
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

export function downloadJson(value, fileName) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  downloadBlob(blob, fileName);
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function imageDataToBlob(imageData, type = "image/png", quality = 0.92) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("画像の書き出しに失敗しました。")), type, quality);
  });
}

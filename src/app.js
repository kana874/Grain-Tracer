import { BmpError, parseBmpHeader, decodeBmpPreview } from "./bmp.js";
import {
  autoTuneBoundary,
  buildBoundaryMask,
  computeBoundaryFeatures,
  renderBoundaryOverlay,
  renderComparisonOverlay,
} from "./analysis.js";
import {
  APP_VERSION,
  ALGORITHM_VERSION,
  createProjectSnapshot,
  downloadProject,
  fingerprintSource,
  restoreReferenceMasks,
  validateProject,
} from "./project.js";
import { loadAutosave, saveAutosave } from "./storage.js";
import { tuneLocalSensitivity } from "./local-tune.js";
import {
  computeFullEvaluationRoiMetrics,
  computeMultiToleranceMetrics,
  computeRegionalMetrics,
  dilateBinaryMask,
  splitReferenceCenterline,
} from "./evaluation.js";
import {
  buildDiagnosticReport,
  downloadBlob,
  downloadJson,
  featureMapImageData,
  imageDataToBlob,
} from "./diagnostics.js";
import {
  applyReferenceHistoryEntry,
  buildClearReferenceEntry,
  createReferenceEditTracker,
  finalizeReferenceEdit,
  paintReferenceCenterlineSegment,
  rebuildReferenceMaskRegion,
  renderBinaryMaskCanvas,
  renderReferenceMaskRegion,
} from "./reference-editor.js";
import {
  buildExclusionMask,
  countMaskPixels,
  hitTestRect,
  normalizeRect,
  rectArea,
  renderExclusionCanvas,
  renderFullEvaluationRoiCanvas,
  transformRect,
} from "./annotations.js";

const $ = id => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  projectInput: $("projectInput"),
  dropZone: $("dropZone"),
  viewer: $("viewer"),
  canvasStage: $("canvasStage"),
  imageCanvas: $("imageCanvas"),
  overlayCanvas: $("overlayCanvas"),
  fullRoiCanvas: $("fullRoiCanvas"),
  exclusionCanvas: $("exclusionCanvas"),
  negativeCanvas: $("negativeCanvas"),
  referenceCanvas: $("referenceCanvas"),
  emptyState: $("emptyState"),
  panToolButton: $("panToolButton"),
  referenceToolButton: $("referenceToolButton"),
  negativeToolButton: $("negativeToolButton"),
  eraseReferenceToolButton: $("eraseReferenceToolButton"),
  exclusionToolButton: $("exclusionToolButton"),
  fullRoiToolButton: $("fullRoiToolButton"),
  undoReferenceButton: $("undoReferenceButton"),
  redoReferenceButton: $("redoReferenceButton"),
  fitButton: $("fitButton"),
  actualButton: $("actualButton"),
  clearOverlayButton: $("clearOverlayButton"),
  analyzeButton: $("analyzeButton"),
  compareButton: $("compareButton"),
  autoTuneButton: $("autoTuneButton"),
  localTuneButton: $("localTuneButton"),
  clearLocalCalibrationButton: $("clearLocalCalibrationButton"),
  clearReferenceButton: $("clearReferenceButton"),
  clearNegativeButton: $("clearNegativeButton"),
  clearExclusionButton: $("clearExclusionButton"),
  clearFullRoiButton: $("clearFullRoiButton"),
  showNormalButton: $("showNormalButton"),
  saveProjectButton: $("saveProjectButton"),
  loadProjectButton: $("loadProjectButton"),
  exportDiagnosticsButton: $("exportDiagnosticsButton"),
  autosaveEnabled: $("autosaveEnabled"),
  zoomLabel: $("zoomLabel"),
  statusText: $("statusText"),
  progressBar: $("progressBar"),
  sensitivity: $("sensitivity"),
  darkWeight: $("darkWeight"),
  ridgeWeight: $("ridgeWeight"),
  colorWeight: $("colorWeight"),
  dendriteWeight: $("dendriteWeight"),
  minComponent: $("minComponent"),
  overlayOpacity: $("overlayOpacity"),
  localEnabled: $("localEnabled"),
  localStrength: $("localStrength"),
  localWindow: $("localWindow"),
  referenceBrush: $("referenceBrush"),
  referenceOpacity: $("referenceOpacity"),
  reviewRadius: $("reviewRadius"),
  metricPositiveRecall: $("metricPositiveRecall"),
  metricNegativeLeakage: $("metricNegativeLeakage"),
  metricAlignment: $("metricAlignment"),
  metricDetail: $("metricDetail"),
  fullRoiMetrics: $("fullRoiMetrics"),
  annotationStatus: $("annotationStatus"),
  localCalibrationStatus: $("localCalibrationStatus"),
  historyList: $("historyList"),
  projectStatus: $("projectStatus"),
  metaName: $("metaName"),
  metaFileSize: $("metaFileSize"),
  metaWidth: $("metaWidth"),
  metaHeight: $("metaHeight"),
  metaBitDepth: $("metaBitDepth"),
  metaCompression: $("metaCompression"),
  metaOrientation: $("metaOrientation"),
};

const state = {
  file: null,
  header: null,
  preview: null,
  features: null,
  featuresKey: null,
  sourceFingerprint: null,
  scale: 1,
  tx: 0,
  ty: 0,
  tool: "pan",
  dragging: false,
  drawingReference: false,
  dragOrigin: null,
  lastReferencePoint: null,
  currentReferenceEdit: null,
  rectInteraction: null,
  selectedExclusionIndex: -1,
  selectedFullRoiIndex: -1,
  undoStack: [],
  redoStack: [],
  analysisMask: null,
  referenceMask: null,
  referenceCenterline: null,
  referenceCount: 0,
  negativeMask: null,
  negativeCenterline: null,
  negativeCount: 0,
  exclusionRects: [],
  exclusionMask: null,
  fullEvaluationRois: [],
  comparisonMode: false,
  lastMetrics: null,
  localCalibration: null,
  history: [],
  busy: false,
  abortController: null,
  autosaveTimer: null,
};

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setStatus(text, progress = null) {
  els.statusText.textContent = text;
  els.progressBar.value = progress == null ? 0 : Math.max(0, Math.min(100, progress));
}

function hasReference() {
  return state.referenceCount > 0;
}

function hasNegativeReference() {
  return state.negativeCount > 0;
}

function hasExclusions() {
  return state.exclusionRects.length > 0;
}

function hasFullEvaluationRois() {
  return state.fullEvaluationRois.length > 0;
}

function updateControls() {
  const hasPreview = Boolean(state.preview);
  const hasAnalysis = Boolean(state.analysisMask);
  const hasRef = hasReference();
  const disabled = state.busy;
  els.fileInput.disabled = disabled;
  els.analyzeButton.disabled = disabled || !hasPreview;
  els.fitButton.disabled = disabled || !hasPreview;
  els.actualButton.disabled = disabled || !hasPreview;
  els.clearOverlayButton.disabled = disabled || !hasAnalysis;
  els.panToolButton.disabled = disabled || !hasPreview;
  els.referenceToolButton.disabled = disabled || !hasPreview;
  els.negativeToolButton.disabled = disabled || !hasPreview;
  els.eraseReferenceToolButton.disabled = disabled || !hasPreview || (!hasRef && !hasNegativeReference());
  els.exclusionToolButton.disabled = disabled || !hasPreview;
  els.fullRoiToolButton.disabled = disabled || !hasPreview;
  els.undoReferenceButton.disabled = disabled || !hasPreview || state.undoStack.length === 0;
  els.redoReferenceButton.disabled = disabled || !hasPreview || state.redoStack.length === 0;
  els.compareButton.disabled = disabled || !hasAnalysis || !hasRef;
  els.autoTuneButton.disabled = disabled || !hasPreview || !hasRef;
  els.localTuneButton.disabled = disabled || !hasPreview || !hasRef;
  els.clearLocalCalibrationButton.disabled = disabled || !state.localCalibration;
  els.clearReferenceButton.disabled = disabled || !hasRef;
  els.clearNegativeButton.disabled = disabled || !hasNegativeReference();
  els.clearExclusionButton.disabled = disabled || !hasExclusions();
  els.clearFullRoiButton.disabled = disabled || !hasFullEvaluationRois();
  els.showNormalButton.disabled = disabled || !state.comparisonMode;
  els.saveProjectButton.disabled = disabled || !hasPreview || !state.sourceFingerprint;
  els.loadProjectButton.disabled = disabled || !hasPreview;
  els.exportDiagnosticsButton.disabled = disabled || !hasPreview || !hasAnalysis || !hasRef;
}

function setBusy(busy) {
  state.busy = busy;
  updateControls();
}

function updateMetadata(file, header) {
  els.metaName.textContent = file.name;
  els.metaFileSize.textContent = formatBytes(file.size);
  els.metaWidth.textContent = `${header.width.toLocaleString()} px`;
  els.metaHeight.textContent = `${header.height.toLocaleString()} px`;
  els.metaBitDepth.textContent = `${header.bitDepth}-bit`;
  els.metaCompression.textContent = header.compressionName;
  els.metaOrientation.textContent = header.topDown ? "Top-down" : "Bottom-up";
}

function resetMetadata() {
  for (const el of [els.metaName, els.metaFileSize, els.metaWidth, els.metaHeight, els.metaBitDepth, els.metaCompression, els.metaOrientation]) {
    el.textContent = "-";
  }
}

function prepareCanvas(width, height) {
  for (const canvas of [els.imageCanvas, els.overlayCanvas, els.fullRoiCanvas, els.exclusionCanvas, els.negativeCanvas, els.referenceCanvas]) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  els.canvasStage.style.width = `${width}px`;
  els.canvasStage.style.height = `${height}px`;
}

function applyTransform() {
  els.canvasStage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  els.zoomLabel.textContent = `${Math.round(state.scale * 100)}% preview`;
}

function fitToViewer() {
  if (!state.preview) return;
  const rect = els.viewer.getBoundingClientRect();
  const margin = 24;
  state.scale = Math.min(
    (rect.width - margin * 2) / state.preview.width,
    (rect.height - margin * 2) / state.preview.height,
  );
  state.scale = Math.max(0.02, state.scale);
  state.tx = (rect.width - state.preview.width * state.scale) / 2;
  state.ty = (rect.height - state.preview.height * state.scale) / 2;
  applyTransform();
}

function actualSize() {
  if (!state.preview) return;
  const rect = els.viewer.getBoundingClientRect();
  state.scale = 1;
  state.tx = (rect.width - state.preview.width) / 2;
  state.ty = (rect.height - state.preview.height) / 2;
  applyTransform();
}

function currentExtractionOptions() {
  return {
    sensitivity: Number(els.sensitivity.value),
    darkWeight: Number(els.darkWeight.value),
    ridgeWeight: Number(els.ridgeWeight.value),
    colorWeight: Number(els.colorWeight.value),
    dendriteWeight: Number(els.dendriteWeight.value),
    minComponent: Number(els.minComponent.value),
  };
}

function currentFeatureOptions() {
  return {
    localEnabled: els.localEnabled.checked,
    localStrength: Number(els.localStrength.value) / 100,
    localWindow: Number(els.localWindow.value),
  };
}

function normalizedReferenceWidth() {
  const raw = Math.max(1, Math.min(15, Math.round(Number(els.referenceBrush.value) || 5)));
  return raw % 2 === 0 ? Math.max(1, raw - 1) : raw;
}

function referenceJudgementRadius() {
  return Math.floor(normalizedReferenceWidth() / 2);
}

function currentComparisonOptions() {
  return {
    tolerance: referenceJudgementRadius(),
    reviewRadius: Number(els.reviewRadius.value),
    opacity: Number(els.overlayOpacity.value),
  };
}

function currentEvaluationOptions(overrides = {}) {
  return {
    ...currentComparisonOptions(),
    negativeMask: state.negativeMask,
    exclusionMask: state.exclusionMask,
    ...overrides,
  };
}

function buildNegativeHoldout() {
  if (!state.preview || !state.negativeCenterline || !hasNegativeReference()) {
    return {
      tuningMask: null,
      validationMask: null,
      validationPixels: 0,
      split: null,
    };
  }
  const split = splitReferenceCenterline(
    state.negativeCenterline,
    state.preview.width,
    state.preview.height,
    { validationFraction: 0.20, minComponentPixels: 8 },
  );
  if (split.validationPixels < 20) {
    return {
      tuningMask: state.negativeMask,
      validationMask: null,
      validationPixels: 0,
      split,
    };
  }
  return {
    tuningMask: dilateBinaryMask(
      split.tuneMask,
      state.preview.width,
      state.preview.height,
      referenceJudgementRadius(),
    ),
    validationMask: dilateBinaryMask(
      split.validationMask,
      state.preview.width,
      state.preview.height,
      referenceJudgementRadius(),
    ),
    validationPixels: split.validationPixels,
    split,
  };
}

function currentBoundaryOptions() {
  return {
    ...currentExtractionOptions(),
    localCalibration: state.localCalibration,
    exclusionMask: state.exclusionMask,
  };
}

function updateLocalCalibrationStatus() {
  if (!state.localCalibration) {
    els.localCalibrationStatus.textContent = "局所補正: 未作成";
    return;
  }
  const measured = (state.localCalibration.measured ?? []).reduce((sum, value) => sum + (value ? 1 : 0), 0);
  const values = state.localCalibration.values ?? [];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const signed = value => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
  els.localCalibrationStatus.textContent =
    `局所補正: ${measured}/${state.localCalibration.cols * state.localCalibration.rows}領域をお手本で校正 / 感度補正 ${signed(min)}～${signed(max)}`;
}

function currentSettings() {
  return {
    extraction: currentExtractionOptions(),
    local: currentFeatureOptions(),
    comparison: currentComparisonOptions(),
    referenceBrush: normalizedReferenceWidth(),
    referenceOpacity: Number(els.referenceOpacity.value),
    overlayOpacity: Number(els.overlayOpacity.value),
    autosaveEnabled: els.autosaveEnabled.checked,
  };
}

function setRangeValue(input, value) {
  input.value = String(Math.round(value));
  const output = $(`${input.id}Value`);
  if (output) output.value = input.value;
}

function applySettings(settings = {}) {
  const extraction = settings.extraction ?? {};
  const local = settings.local ?? {};
  const comparison = settings.comparison ?? {};
  if (extraction.sensitivity != null) setRangeValue(els.sensitivity, extraction.sensitivity);
  if (extraction.darkWeight != null) setRangeValue(els.darkWeight, extraction.darkWeight);
  if (extraction.ridgeWeight != null) setRangeValue(els.ridgeWeight, extraction.ridgeWeight);
  if (extraction.colorWeight != null) setRangeValue(els.colorWeight, extraction.colorWeight);
  if (extraction.dendriteWeight != null) setRangeValue(els.dendriteWeight, extraction.dendriteWeight);
  if (extraction.minComponent != null) setRangeValue(els.minComponent, extraction.minComponent);
  if (local.enabled != null) els.localEnabled.checked = Boolean(local.enabled);
  if (local.localEnabled != null) els.localEnabled.checked = Boolean(local.localEnabled);
  if (local.strength != null) setRangeValue(els.localStrength, local.strength <= 1 ? local.strength * 100 : local.strength);
  if (local.localStrength != null) setRangeValue(els.localStrength, local.localStrength <= 1 ? local.localStrength * 100 : local.localStrength);
  if (local.window != null) setRangeValue(els.localWindow, local.window);
  if (local.localWindow != null) setRangeValue(els.localWindow, local.localWindow);
  if (comparison.reviewRadius != null) setRangeValue(els.reviewRadius, comparison.reviewRadius);
  if (settings.referenceBrush != null) {
    setRangeValue(els.referenceBrush, settings.referenceBrush);
  } else if (comparison.tolerance != null) {
    setRangeValue(els.referenceBrush, comparison.tolerance * 2 + 1);
  }
  if (settings.referenceOpacity != null) setRangeValue(els.referenceOpacity, settings.referenceOpacity);
  if (settings.overlayOpacity != null) setRangeValue(els.overlayOpacity, settings.overlayOpacity);
  if (settings.autosaveEnabled != null) els.autosaveEnabled.checked = Boolean(settings.autosaveEnabled);
  invalidateFeatures();
}

function invalidateFeatures() {
  state.features = null;
  state.featuresKey = null;
}

function clearLocalCalibration(silent = false) {
  state.localCalibration = null;
  updateLocalCalibrationStatus();
  updateControls();
  if (!silent) {
    state.analysisMask = null;
    renderNormalOverlay();
    updateMetrics();
    setStatus("局所補正を解除しました。再度粒界抽出してください。");
  }
}

function extractionSettingChanged() {
  clearLocalCalibration(true);
  scheduleAutosave();
}

function featureSettingChanged() {
  invalidateFeatures();
  clearLocalCalibration(true);
  scheduleAutosave();
}

function updateMetrics(metrics = null) {
  state.lastMetrics = metrics;
  if (!metrics) {
    els.metricPositiveRecall.textContent = "-";
    els.metricNegativeLeakage.textContent = "-";
    els.metricAlignment.textContent = "-";
    els.metricDetail.textContent = hasReference()
      ? "自動抽出後に「比較」を押してください。未記入領域はUnknownです。"
      : "お手本線を描くとPartial Label評価できます。";
    els.fullRoiMetrics.textContent = hasFullEvaluationRois()
      ? "完全評価ROIがあります。比較後に True Precision / Recall / F1 を表示します。"
      : "完全評価ROIを指定すると True Precision / Recall / F1 を表示します。";
    return;
  }

  els.metricPositiveRecall.textContent = `${(metrics.positiveRecall * 100).toFixed(1)}%`;
  els.metricNegativeLeakage.textContent = `${(metrics.negativeLeakage * 100).toFixed(1)}%`;
  const alignment = metrics.alignmentError?.mean;
  els.metricAlignment.textContent = alignment == null ? "-" : `${alignment.toFixed(2)} px`;

  const negativeText = metrics.negativePixels
    ? `　Negative漏れ ${metrics.negativePrediction.toLocaleString()} / ${metrics.negativePixels.toLocaleString()} px`
    : "";
  const unknownText = `　Unknown上の自動線 ${(metrics.unknownPrediction ?? 0).toLocaleString()} px（FPに含めない）`;
  els.metricDetail.textContent =
    `Positive: 一致 ${metrics.matchedReference.toLocaleString()} / 見逃し ${metrics.falseNegative.toLocaleString()} px${negativeText}${unknownText}`;

  if (hasFullEvaluationRois() && state.analysisMask && state.preview) {
    const roi = computeFullEvaluationRoiMetrics(
      state.analysisMask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      state.fullEvaluationRois,
      {
        tolerance: currentComparisonOptions().tolerance,
        exclusionMask: state.exclusionMask,
      },
    );
    els.fullRoiMetrics.textContent =
      `完全評価ROI ${roi.roiCount}領域 / True Precision ${(roi.precision * 100).toFixed(1)}% / True Recall ${(roi.recall * 100).toFixed(1)}% / True F1 ${(roi.f1 * 100).toFixed(1)}% / Tolerance ${roi.tolerance}px`;
  } else {
    els.fullRoiMetrics.textContent =
      "完全評価ROIを指定すると True Precision / Recall / F1 を表示します。";
  }
}

function renderHistory() {
  els.historyList.replaceChildren();
  const items = [...state.history].slice(-8).reverse();
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "評価履歴はまだありません。";
    li.className = "history-empty";
    els.historyList.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const date = new Date(item.timestamp);
    const positiveRecall = item.metrics?.positiveRecall ?? item.metrics?.recall;
    const negativeLeakage = item.metrics?.negativeLeakage ?? item.metrics?.negativeHitRate;
    const recallText = positiveRecall == null ? "-" : `${(positiveRecall * 100).toFixed(1)}%`;
    const leakText = negativeLeakage == null ? "-" : `${(negativeLeakage * 100).toFixed(1)}%`;
    const label = item.kind === "auto-tune" ? "全体調整" : item.kind === "local-tune" ? "局所調整" : "比較";
    li.innerHTML = `<strong>${label}</strong><span>R ${recallText} / Leak ${leakText}</span><small>${date.toLocaleString("ja-JP")}</small>`;
    els.historyList.appendChild(li);
  }
}

function addHistory(kind, metrics, note = "") {
  const cleanRegions = (metrics.regions ?? []).map(region => ({
    rx: region.rx, ry: region.ry, precision: region.precision, recall: region.recall,
    f1: region.f1, referencePixels: region.referencePixels,
  }));
  state.history.push({
    timestamp: new Date().toISOString(),
    kind,
    algorithmVersion: ALGORITHM_VERSION,
    parameters: currentExtractionOptions(),
    local: currentFeatureOptions(),
    localCalibration: state.localCalibration ? {
      cols: state.localCalibration.cols,
      rows: state.localCalibration.rows,
      baseSensitivity: state.localCalibration.baseSensitivity,
      values: state.localCalibration.values,
      measured: state.localCalibration.measured,
    } : null,
    metrics: {
      evaluationMode: metrics.evaluationMode ?? "partial-label",
      positiveRecall: metrics.positiveRecall ?? metrics.recall,
      negativeLeakage: metrics.negativeLeakage ?? metrics.negativeHitRate ?? 0,
      alignmentError: metrics.alignmentError ?? null,
      labelPrecisionProxy: metrics.labelPrecision ?? metrics.precision,
      labelF1Proxy: metrics.labelF1 ?? metrics.f1,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      matchedPrediction: metrics.matchedPrediction,
      falsePositive: metrics.falsePositive,
      matchedReference: metrics.matchedReference,
      falseNegative: metrics.falseNegative,
      unknownPrediction: metrics.unknownPrediction ?? 0,
      negativePrediction: metrics.negativePrediction ?? 0,
      negativePixels: metrics.negativePixels ?? 0,
      negativeHitRate: metrics.negativeHitRate ?? 0,
      excludedPixels: metrics.excludedPixels ?? 0,
      regions: cleanRegions,
    },
    note,
  });
  if (state.history.length > 100) state.history.splice(0, state.history.length - 100);
  renderHistory();
  scheduleAutosave();
}

function renderNormalOverlay() {
  if (!state.preview) return;
  const ctx = els.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, state.preview.width, state.preview.height);
  if (state.analysisMask) {
    ctx.putImageData(renderBoundaryOverlay(state.analysisMask, state.preview.width, state.preview.height, {
      opacity: Number(els.overlayOpacity.value),
    }), 0, 0);
  }
  els.referenceCanvas.style.visibility = "visible";
  els.negativeCanvas.style.visibility = "visible";
  els.exclusionCanvas.style.visibility = "visible";
  els.fullRoiCanvas.style.visibility = "visible";
  state.comparisonMode = false;
  updateControls();
}

function renderReferenceCanvas() {
  if (!state.preview || !state.referenceCenterline) return;
  state.referenceMask = dilateBinaryMask(
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
    referenceJudgementRadius(),
  );
  const rgba = new Uint8ClampedArray(state.referenceMask.length * 4);
  for (let p = 0; p < state.referenceMask.length; p += 1) {
    if (!state.referenceMask[p]) continue;
    const i = p * 4;
    rgba[i] = 255;
    rgba[i + 1] = 216;
    rgba[i + 2] = 74;
    rgba[i + 3] = Math.round(255 * Math.max(0.1, Math.min(1, Number(els.referenceOpacity.value) / 100)));
  }
  els.referenceCanvas.getContext("2d").putImageData(new ImageData(rgba, state.preview.width, state.preview.height), 0, 0);
}

function renderNegativeCanvas() {
  if (!state.preview || !state.negativeCenterline) return;
  state.negativeMask = dilateBinaryMask(
    state.negativeCenterline,
    state.preview.width,
    state.preview.height,
    referenceJudgementRadius(),
  );
  renderBinaryMaskCanvas(
    els.negativeCanvas,
    state.negativeMask,
    state.preview.width,
    state.preview.height,
    referenceOpacityRatio(),
    [255, 138, 0],
  );
}

function annotationHandleSize() {
  return state.scale > 0 ? Math.max(6, Math.min(22, 9 / state.scale)) : 9;
}

function annotationHitThreshold() {
  return state.scale > 0 ? Math.max(4, Math.min(18, 7 / state.scale)) : 7;
}

function rebuildExclusionLayer(previewRect = null, showSelection = true) {
  if (!state.preview) return;
  state.exclusionMask = buildExclusionMask(
    state.exclusionRects,
    state.preview.width,
    state.preview.height,
  );
  renderExclusionCanvas(
    els.exclusionCanvas,
    state.exclusionRects,
    state.preview.width,
    state.preview.height,
    previewRect,
    showSelection && state.tool === "exclusion" ? state.selectedExclusionIndex : -1,
    annotationHandleSize(),
  );
  updateAnnotationStatus();
}

function rebuildFullRoiLayer(previewRect = null, showSelection = true) {
  if (!state.preview) return;
  renderFullEvaluationRoiCanvas(
    els.fullRoiCanvas,
    state.fullEvaluationRois,
    state.preview.width,
    state.preview.height,
    previewRect,
    showSelection && state.tool === "full-roi" ? state.selectedFullRoiIndex : -1,
    annotationHandleSize(),
  );
  updateAnnotationStatus();
}

function updateAnnotationStatus() {
  const negative = state.negativeCount ?? 0;
  const excluded = state.exclusionMask ? countMaskPixels(state.exclusionMask) : 0;
  els.annotationStatus.textContent =
    `非粒界: ${negative.toLocaleString()} px / 除外: ${state.exclusionRects.length}領域 (${excluded.toLocaleString()} px) / 完全評価ROI: ${state.fullEvaluationRois.length}領域`;
}

function resetReferenceHistory() {
  state.undoStack = [];
  state.redoStack = [];
  state.currentReferenceEdit = null;
  updateControls();
}

function referenceOpacityRatio() {
  return Math.max(0.1, Math.min(1, Number(els.referenceOpacity.value) / 100));
}

function refreshReferenceDirty(changedBounds) {
  if (!state.preview || !state.referenceCenterline || !state.referenceMask || !changedBounds) return;
  const dirty = rebuildReferenceMaskRegion(
    state.referenceCenterline,
    state.referenceMask,
    state.preview.width,
    state.preview.height,
    referenceJudgementRadius(),
    changedBounds,
  );
  renderReferenceMaskRegion(
    els.referenceCanvas,
    state.referenceMask,
    state.preview.width,
    dirty,
    referenceOpacityRatio(),
    [255, 216, 74],
  );
}

function refreshNegativeDirty(changedBounds) {
  if (!state.preview || !state.negativeCenterline || !state.negativeMask || !changedBounds) return;
  const dirty = rebuildReferenceMaskRegion(
    state.negativeCenterline,
    state.negativeMask,
    state.preview.width,
    state.preview.height,
    referenceJudgementRadius(),
    changedBounds,
  );
  renderReferenceMaskRegion(
    els.negativeCanvas,
    state.negativeMask,
    state.preview.width,
    dirty,
    referenceOpacityRatio(),
    [255, 138, 0],
  );
}

function commitReferenceHistory(entry) {
  if (!entry) return;
  state.undoStack.push(entry);
  if (state.undoStack.length > 120) state.undoStack.splice(0, state.undoStack.length - 120);
  state.redoStack = [];
  updateControls();
}

function invalidateAfterReferenceEdit(affectsAnalysis = false) {
  clearLocalCalibration(true);
  state.comparisonMode = false;
  els.referenceCanvas.style.visibility = "visible";
  els.negativeCanvas.style.visibility = "visible";
  els.exclusionCanvas.style.visibility = "visible";
  els.fullRoiCanvas.style.visibility = "visible";
  if (affectsAnalysis) {
    state.analysisMask = null;
    els.overlayCanvas.getContext("2d").clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  }
  updateMetrics();
}

function recalcAnnotationCounts() {
  state.referenceCount = state.referenceCenterline
    ? state.referenceCenterline.reduce((sum, value) => sum + (value ? 1 : 0), 0)
    : 0;
  state.negativeCount = state.negativeCenterline
    ? state.negativeCenterline.reduce((sum, value) => sum + (value ? 1 : 0), 0)
    : 0;
  updateAnnotationStatus();
}

function applyMaskHistoryPart(part, direction) {
  const centerline = part.layer === "negative" ? state.negativeCenterline : state.referenceCenterline;
  const bounds = applyReferenceHistoryEntry(centerline, part.entry, direction);
  if (part.layer === "negative") refreshNegativeDirty(bounds);
  else refreshReferenceDirty(bounds);
}

function applyReferenceUndoRedo(direction) {
  const source = direction === "redo" ? state.redoStack : state.undoStack;
  const target = direction === "redo" ? state.undoStack : state.redoStack;
  if (!state.preview || source.length === 0) return;

  if (state.comparisonMode) showNormalView();
  const item = source.pop();
  const affectsAnalysis = item.kind.startsWith("exclusion-");
  invalidateAfterReferenceEdit(affectsAnalysis);

  if (item.kind === "mask-edit") {
    for (const part of item.parts) applyMaskHistoryPart(part, direction);
  } else if (item.kind === "exclusion-add") {
    if (direction === "undo") state.exclusionRects.splice(item.index, 1);
    else state.exclusionRects.splice(item.index, 0, { ...item.rect });
    state.selectedExclusionIndex = -1;
    rebuildExclusionLayer();
  } else if (item.kind === "exclusion-edit") {
    state.exclusionRects[item.index] = { ...(direction === "undo" ? item.before : item.after) };
    state.selectedExclusionIndex = item.index;
    rebuildExclusionLayer();
  } else if (item.kind === "exclusion-delete") {
    if (direction === "undo") state.exclusionRects.splice(item.index, 0, { ...item.rect });
    else state.exclusionRects.splice(item.index, 1);
    state.selectedExclusionIndex = direction === "undo" ? item.index : -1;
    rebuildExclusionLayer();
  } else if (item.kind === "exclusion-clear") {
    state.exclusionRects = direction === "undo"
      ? item.rects.map(rect => ({ ...rect }))
      : [];
    state.selectedExclusionIndex = -1;
    rebuildExclusionLayer();
  } else if (item.kind === "roi-add") {
    if (direction === "undo") state.fullEvaluationRois.splice(item.index, 1);
    else state.fullEvaluationRois.splice(item.index, 0, { ...item.rect });
    state.selectedFullRoiIndex = -1;
    rebuildFullRoiLayer();
  } else if (item.kind === "roi-edit") {
    state.fullEvaluationRois[item.index] = { ...(direction === "undo" ? item.before : item.after) };
    state.selectedFullRoiIndex = item.index;
    rebuildFullRoiLayer();
  } else if (item.kind === "roi-delete") {
    if (direction === "undo") state.fullEvaluationRois.splice(item.index, 0, { ...item.rect });
    else state.fullEvaluationRois.splice(item.index, 1);
    state.selectedFullRoiIndex = direction === "undo" ? item.index : -1;
    rebuildFullRoiLayer();
  } else if (item.kind === "roi-clear") {
    state.fullEvaluationRois = direction === "undo"
      ? item.rects.map(rect => ({ ...rect }))
      : [];
    state.selectedFullRoiIndex = -1;
    rebuildFullRoiLayer();
  }

  target.push(item);
  recalcAnnotationCounts();
  updateControls();
  setStatus(`注釈を${direction === "redo" ? "やり直しました" : "元に戻しました"}。`);
  scheduleAutosave();
}

function undoReference() {
  applyReferenceUndoRedo("undo");
}

function redoReference() {
  applyReferenceUndoRedo("redo");
}

function showNormalView() {
  renderNormalOverlay();
  updateMetrics();
  setStatus("通常表示に戻しました。");
}

function clearOverlay() {
  els.overlayCanvas.getContext("2d").clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  state.analysisMask = null;
  state.comparisonMode = false;
  els.referenceCanvas.style.visibility = "visible";
  els.negativeCanvas.style.visibility = "visible";
  els.exclusionCanvas.style.visibility = "visible";
  els.fullRoiCanvas.style.visibility = "visible";
  updateMetrics();
  updateControls();
  setStatus("粒界オーバーレイを消去しました。");
}

function clearReference() {
  if (!state.preview || !state.referenceCenterline || !hasReference()) return;
  if (state.comparisonMode) showNormalView();
  invalidateAfterReferenceEdit();

  const entry = buildClearReferenceEntry(
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
  );
  if (!entry) return;

  state.referenceCenterline.fill(0);
  state.referenceMask.fill(0);
  els.referenceCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  commitReferenceHistory({ kind: "mask-edit", parts: [{ layer: "reference", entry }] });
  recalcAnnotationCounts();
  renderNormalOverlay();
  updateControls();
  setStatus("粒界お手本を全消去しました。Undoで復元できます。");
  scheduleAutosave();
}

function clearNegativeReference() {
  if (!state.preview || !state.negativeCenterline || !hasNegativeReference()) return;
  if (state.comparisonMode) showNormalView();
  invalidateAfterReferenceEdit();

  const entry = buildClearReferenceEntry(
    state.negativeCenterline,
    state.preview.width,
    state.preview.height,
  );
  if (!entry) return;

  state.negativeCenterline.fill(0);
  state.negativeMask.fill(0);
  els.negativeCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  commitReferenceHistory({ kind: "mask-edit", parts: [{ layer: "negative", entry }] });
  recalcAnnotationCounts();
  renderNormalOverlay();
  updateControls();
  setStatus("非粒界お手本を全消去しました。Undoで復元できます。");
  scheduleAutosave();
}

function clearExclusions() {
  if (!state.preview || !hasExclusions()) return;
  if (state.comparisonMode) showNormalView();
  const item = {
    kind: "exclusion-clear",
    rects: state.exclusionRects.map(rect => ({ ...rect })),
  };
  state.exclusionRects = [];
  state.selectedExclusionIndex = -1;
  rebuildExclusionLayer();
  invalidateAfterReferenceEdit(true);
  commitReferenceHistory(item);
  updateControls();
  setStatus("除外領域を全消去しました。再解析してください。Undoで復元できます。");
  scheduleAutosave();
}

function clearFullEvaluationRois() {
  if (!state.preview || !hasFullEvaluationRois()) return;
  if (state.comparisonMode) showNormalView();
  const item = {
    kind: "roi-clear",
    rects: state.fullEvaluationRois.map(rect => ({ ...rect })),
  };
  state.fullEvaluationRois = [];
  state.selectedFullRoiIndex = -1;
  rebuildFullRoiLayer();
  invalidateAfterReferenceEdit(false);
  commitReferenceHistory(item);
  updateControls();
  setStatus("完全評価ROIを全消去しました。Undoで復元できます。");
  scheduleAutosave();
}

function buildProject() {
  if (!state.preview || !state.header || !state.file || !state.sourceFingerprint) throw new Error("保存できるプロジェクトがありません。");
  return createProjectSnapshot({
    source: {
      name: state.file.name,
      size: state.file.size,
      width: state.header.width,
      height: state.header.height,
      bitDepth: state.header.bitDepth,
      fingerprint: state.sourceFingerprint,
    },
    preview: state.preview,
    settings: currentSettings(),
    referenceMask: state.referenceMask,
    referenceCenterline: state.referenceCenterline,
    negativeMask: state.negativeMask,
    negativeCenterline: state.negativeCenterline,
    exclusionRects: state.exclusionRects,
    fullEvaluationRois: state.fullEvaluationRois,
    localCalibration: state.localCalibration,
    history: state.history,
  });
}

function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  if (!els.autosaveEnabled.checked || !state.sourceFingerprint || !state.preview) return;
  state.autosaveTimer = setTimeout(async () => {
    try {
      await saveAutosave(state.sourceFingerprint, buildProject());
      els.projectStatus.textContent = `自動保存済み ${new Date().toLocaleTimeString("ja-JP")}`;
    } catch (error) {
      console.warn("autosave failed", error);
      els.projectStatus.textContent = "自動保存に失敗しました";
    }
  }, 700);
}

async function restoreProject(project, source = "プロジェクト") {
  validateProject(project);
  if (!state.preview || !state.sourceFingerprint) throw new Error("先に対応するBMPを開いてください。");
  if (project.source?.fingerprint && project.source.fingerprint !== state.sourceFingerprint) {
    throw new Error("現在のBMPとプロジェクトの画像指紋が一致しません。");
  }
  if (project.preview.width !== state.preview.width || project.preview.height !== state.preview.height) {
    throw new Error("プロジェクト作成時と現在のプレビュー寸法が一致しません。");
  }
  const masks = restoreReferenceMasks(project);
  state.referenceMask = masks.referenceMask;
  state.referenceCenterline = masks.referenceCenterline;
  state.negativeMask = masks.negativeMask;
  state.negativeCenterline = masks.negativeCenterline;
  state.exclusionRects = masks.exclusionRects;
  state.fullEvaluationRois = masks.fullEvaluationRois;
  state.selectedExclusionIndex = -1;
  state.selectedFullRoiIndex = -1;
  state.referenceCount = state.referenceCenterline.reduce((sum, value) => sum + value, 0);
  state.negativeCount = state.negativeCenterline.reduce((sum, value) => sum + value, 0);
  resetReferenceHistory();
  state.history = Array.isArray(project.history) ? project.history : [];
  state.localCalibration = project.localCalibration ?? null;
  applySettings(project.settings ?? {});
  updateLocalCalibrationStatus();
  renderReferenceCanvas();
  renderNegativeCanvas();
  rebuildExclusionLayer();
  rebuildFullRoiLayer();
  renderHistory();
  state.analysisMask = null;
  renderNormalOverlay();
  updateMetrics();
  updateControls();
  els.projectStatus.textContent = `${source}を復元しました`;
  setStatus(`${source}を復元しました。粒界お手本 ${state.referenceCount.toLocaleString()} px / 非粒界 ${state.negativeCount.toLocaleString()} px / 除外 ${state.exclusionRects.length}領域 / 完全評価ROI ${state.fullEvaluationRois.length}領域`, 100);
}

async function saveProjectManual() {
  try {
    const project = buildProject();
    const base = state.file.name.replace(/\.bmp$/i, "");
    downloadProject(project, `${base}.graintracer.json`);
    await saveAutosave(state.sourceFingerprint, project);
    els.projectStatus.textContent = "プロジェクトを保存しました";
  } catch (error) {
    alert(error.message);
  }
}

async function importProjectFile(file) {
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    await restoreProject(project, "プロジェクトファイル");
    scheduleAutosave();
  } catch (error) {
    alert(`プロジェクト読込エラー: ${error.message}`);
  } finally {
    els.projectInput.value = "";
  }
}

async function exportDiagnostics() {
  if (!state.preview || !state.analysisMask || !hasReference()) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    const source = {
      name: state.file?.name ?? "",
      size: state.file?.size ?? 0,
      width: state.header?.width ?? 0,
      height: state.header?.height ?? 0,
      bitDepth: state.header?.bitDepth ?? 0,
      fingerprint: state.sourceFingerprint,
    };
    const settings = currentSettings();
    const report = buildDiagnosticReport({
      source,
      preview: state.preview,
      settings,
      features,
      prediction: state.analysisMask,
      referenceCenterline: state.referenceCenterline,
      negativeMask: state.negativeMask,
      negativeCenterline: state.negativeCenterline,
      exclusionMask: state.exclusionMask,
      exclusionRects: state.exclusionRects,
      fullEvaluationRois: state.fullEvaluationRois,
      localCalibration: state.localCalibration,
      history: state.history,
      algorithmVersion: ALGORITHM_VERSION,
      appVersion: APP_VERSION,
    });

    const comparison = renderComparisonOverlay(
      state.analysisMask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentEvaluationOptions(),
    );
    const referenceImage = els.referenceCanvas.getContext("2d").getImageData(
      0,
      0,
      state.preview.width,
      state.preview.height,
    );
    const negativeImage = els.negativeCanvas.getContext("2d").getImageData(
      0,
      0,
      state.preview.width,
      state.preview.height,
    );
    rebuildExclusionLayer(null, false);
    rebuildFullRoiLayer(null, false);
    const exclusionImage = els.exclusionCanvas.getContext("2d").getImageData(
      0,
      0,
      state.preview.width,
      state.preview.height,
    );
    const fullRoiImage = els.fullRoiCanvas.getContext("2d").getImageData(
      0,
      0,
      state.preview.width,
      state.preview.height,
    );
    rebuildExclusionLayer();
    rebuildFullRoiLayer();
    const ridgeImage = featureMapImageData(
      features.ridge,
      state.preview.width,
      state.preview.height,
    );
    const dendriteImage = featureMapImageData(
      features.dendrite,
      state.preview.width,
      state.preview.height,
    );
    const base = (state.file?.name ?? "graintracer").replace(/\.bmp$/i, "");

    setStatus("診断JSONを作成中...", 82);
    downloadJson(report, `${base}.graintracer-diagnostic.json`);
    await new Promise(resolve => setTimeout(resolve, 120));

    setStatus("診断画像を書き出し中...", 88);
    downloadBlob(
      await imageDataToBlob(state.preview.imageData, "image/jpeg", 0.90),
      `${base}.graintracer-preview.jpg`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(comparison.imageData, "image/png"),
      `${base}.graintracer-comparison.png`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(ridgeImage, "image/png"),
      `${base}.graintracer-ridge.png`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(dendriteImage, "image/png"),
      `${base}.graintracer-dendrite.png`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(referenceImage, "image/png"),
      `${base}.graintracer-reference.png`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(negativeImage, "image/png"),
      `${base}.graintracer-non-boundary.png`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(exclusionImage, "image/png"),
      `${base}.graintracer-exclusion.png`,
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    downloadBlob(
      await imageDataToBlob(fullRoiImage, "image/png"),
      `${base}.graintracer-full-roi.png`,
    );

    const roiText = report.evaluation.fullEvaluationRoi?.roiCount
      ? ` / ROI True F1 ${(report.evaluation.fullEvaluationRoi.f1 * 100).toFixed(1)}%`
      : "";
    setStatus(
      `診断出力完了: Positive Recall ${(report.evaluation.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(report.evaluation.negativeLeakage * 100).toFixed(1)}%${roiText}`,
      100,
    );
  } catch (error) {
    console.error(error);
    setStatus(`診断出力エラー: ${error.message}`, 0);
    alert(`診断出力エラー: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadBmp(file) {
  if (!file) return;
  state.abortController?.abort();
  state.abortController = new AbortController();
  setBusy(true);
  clearOverlay();
  resetMetadata();
  invalidateFeatures();
  state.referenceCount = 0;
  state.referenceMask = null;
  state.referenceCenterline = null;
  state.negativeCount = 0;
  state.negativeMask = null;
  state.negativeCenterline = null;
  state.exclusionRects = [];
  state.exclusionMask = null;
  state.fullEvaluationRois = [];
  state.selectedExclusionIndex = -1;
  state.selectedFullRoiIndex = -1;
  state.rectInteraction = null;
  resetReferenceHistory();
  state.sourceFingerprint = null;
  state.localCalibration = null;
  updateLocalCalibrationStatus();
  state.history = [];
  renderHistory();

  try {
    setStatus("BMPヘッダーを確認中...", 2);
    const header = await parseBmpHeader(file);
    state.file = file;
    state.header = header;
    updateMetadata(file, header);

    setStatus("縮小プレビューを作成中...", 5);
    const preview = await decodeBmpPreview(file, header, {
      maxWidth: 1800,
      maxHeight: 1400,
      signal: state.abortController.signal,
      onProgress: ratio => setStatus(`縮小プレビューを作成中... ${Math.round(ratio * 100)}%`, 5 + ratio * 80),
    });

    state.preview = preview;
    state.referenceMask = new Uint8Array(preview.width * preview.height);
    state.referenceCenterline = new Uint8Array(preview.width * preview.height);
    state.negativeMask = new Uint8Array(preview.width * preview.height);
    state.negativeCenterline = new Uint8Array(preview.width * preview.height);
    state.exclusionMask = new Uint8Array(preview.width * preview.height);
    state.exclusionRects = [];
    state.fullEvaluationRois = [];
    prepareCanvas(preview.width, preview.height);
    els.imageCanvas.getContext("2d").putImageData(preview.imageData, 0, 0);
    els.overlayCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.fullRoiCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.referenceCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.negativeCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.exclusionCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    updateAnnotationStatus();
    els.canvasStage.style.display = "block";
    els.emptyState.style.display = "none";
    setTool("pan");
    fitToViewer();
    updateMetrics();

    setStatus("画像指紋を作成中...", 90);
    state.sourceFingerprint = await fingerprintSource(file, header);
    updateControls();

    let restored = false;
    if (els.autosaveEnabled.checked) {
      const autosave = await loadAutosave(state.sourceFingerprint);
      if (autosave) {
        await restoreProject(autosave, "自動保存");
        restored = true;
      }
    }
    if (!restored) {
      els.projectStatus.textContent = "新規プロジェクト";
      setStatus(`読込完了: ${header.width.toLocaleString()} × ${header.height.toLocaleString()} px → preview ${preview.width} × ${preview.height} px`, 100);
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error(error);
    state.file = null;
    state.header = null;
    state.preview = null;
    invalidateFeatures();
    state.referenceMask = null;
    state.referenceCenterline = null;
    state.negativeMask = null;
    state.negativeCenterline = null;
    state.exclusionMask = null;
    state.exclusionRects = [];
    state.fullEvaluationRois = [];
    state.selectedExclusionIndex = -1;
    state.selectedFullRoiIndex = -1;
    state.rectInteraction = null;
    els.canvasStage.style.display = "none";
    els.emptyState.style.display = "grid";
    const message = error instanceof BmpError ? error.message : `読込エラー: ${error.message}`;
    setStatus(message, 0);
    alert(message);
  } finally {
    setBusy(false);
  }
}

async function ensureFeatures() {
  if (!state.preview) throw new Error("画像がありません。");
  const options = currentFeatureOptions();
  const key = JSON.stringify(options);
  if (state.features && state.featuresKey === key) return state.features;
  setStatus(`特徴量を計算中... Dark Ridge + 色差 + デンドライト + ${options.localEnabled ? "局所適応" : "全体基準"}`, 1);
  state.features = await computeBoundaryFeatures(state.preview.imageData, {
    ...options,
    onProgress: ratio => setStatus(`特徴量を計算中... ${Math.round(ratio * 100)}%`, ratio * 70),
  });
  state.featuresKey = key;
  return state.features;
}

async function analyzePreview() {
  if (!state.preview) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    setStatus("粒界候補を解析中...", 72);
    state.analysisMask = await buildBoundaryMask(features, {
      ...currentBoundaryOptions(),
      onProgress: ratio => setStatus(`粒界候補を解析中... ${Math.round(ratio * 100)}%`, 72 + ratio * 27),
    });
    renderNormalOverlay();
    updateMetrics();
    const count = state.analysisMask.reduce((sum, value) => sum + value, 0);
    setStatus(`粒界候補を表示しました。候補画素: ${count.toLocaleString()}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`解析エラー: ${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

function compareCurrent(record = true) {
  if (!state.preview || !state.analysisMask || !hasReference()) return null;
  const result = renderComparisonOverlay(
    state.analysisMask,
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
    currentEvaluationOptions(),
  );
  els.overlayCanvas.getContext("2d").putImageData(result.imageData, 0, 0);
  els.referenceCanvas.style.visibility = "hidden";
  els.negativeCanvas.style.visibility = "hidden";
  state.comparisonMode = true;
  result.metrics.multiTolerance = computeMultiToleranceMetrics(
    state.analysisMask,
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
    {
      tolerances: [1, 2, 3, 4],
      reviewRadius: currentComparisonOptions().reviewRadius,
      negativeMask: state.negativeMask,
      exclusionMask: state.exclusionMask,
    },
  );
  updateMetrics(result.metrics);
  updateControls();
  if (record) addHistory("compare", result.metrics);
  const tol1 = result.metrics.multiTolerance.find(item => item.tolerance === 1);
  const tol4 = result.metrics.multiTolerance.find(item => item.tolerance === 4);
  const toleranceText = tol1 && tol4
    ? ` / Recall@1px ${(tol1.positiveRecall * 100).toFixed(1)}% → @4px ${(tol4.positiveRecall * 100).toFixed(1)}%`
    : "";
  setStatus(`比較完了: Positive Recall ${(result.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(result.metrics.negativeLeakage * 100).toFixed(1)}%${toleranceText}`, 100);
  return result;
}

async function autoTune() {
  if (!state.preview || !hasReference()) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    const split = splitReferenceCenterline(
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      { validationFraction: 0.20, minComponentPixels: 8 },
    );
    const tuningReference = split.validationPixels >= 40 ? split.tuneMask : state.referenceCenterline;
    const negativeHoldout = buildNegativeHoldout();
    setStatus("調整用お手本＋非粒界例でDark/Ridge/Color/デンドライトを自動調整中...", 1);
    const result = await autoTuneBoundary(features, tuningReference, {
      ...currentComparisonOptions(),
      negativeMask: negativeHoldout.tuningMask,
      exclusionMask: state.exclusionMask,
      current: currentExtractionOptions(),
      onProgress: ratio => setStatus(`自動調整中... ${Math.round(ratio * 100)}%`, ratio * 99),
    });
    setRangeValue(els.sensitivity, result.parameters.sensitivity);
    setRangeValue(els.darkWeight, result.parameters.darkWeight);
    setRangeValue(els.ridgeWeight, result.parameters.ridgeWeight);
    setRangeValue(els.colorWeight, result.parameters.colorWeight);
    setRangeValue(els.dendriteWeight, result.parameters.dendriteWeight ?? Number(els.dendriteWeight.value));
    setRangeValue(els.minComponent, result.parameters.minComponent);
    state.localCalibration = null;
    updateLocalCalibrationStatus();
    state.analysisMask = result.mask;

    const comparison = renderComparisonOverlay(
      result.mask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentEvaluationOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    els.referenceCanvas.style.visibility = "hidden";
    els.negativeCanvas.style.visibility = "hidden";
    state.comparisonMode = true;
    updateMetrics(comparison.metrics);
    const validationMetrics = split.validationPixels >= 40
      ? computeRegionalMetrics(
        result.mask,
        split.validationMask,
        state.preview.width,
        state.preview.height,
        {
          ...currentComparisonOptions(),
          negativeMask: negativeHoldout.validationMask,
          exclusionMask: state.exclusionMask,
          cols: 4,
          rows: 4,
        },
      )
      : null;
    const validationNote = validationMetrics
      ? ` / 検証 Positive Recall ${(validationMetrics.positiveRecall * 100).toFixed(1)}%`
      : "";
    addHistory(
      "auto-tune",
      comparison.metrics,
      validationMetrics
        ? `partial-label tuning; holdout positiveRecall=${validationMetrics.positiveRecall.toFixed(4)}, negativeLeakage=${validationMetrics.negativeLeakage.toFixed(4)}`
        : "partial-label tuning; validation holdout unavailable",
    );
    setStatus(`自動調整完了: Positive Recall ${(comparison.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(comparison.metrics.negativeLeakage * 100).toFixed(1)}%${validationNote} / 感度 ${result.parameters.sensitivity} / 暗さ ${result.parameters.darkWeight} / Ridge ${result.parameters.ridgeWeight} / 色差 ${result.parameters.colorWeight} / デンドライト ${result.parameters.dendriteWeight ?? 0}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`自動調整エラー: ${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

async function localTune() {
  if (!state.preview || !hasReference()) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    const extraction = currentExtractionOptions();
    const split = splitReferenceCenterline(
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      { validationFraction: 0.20, minComponentPixels: 8 },
    );
    const tuningReference = split.validationPixels >= 40 ? split.tuneMask : state.referenceCenterline;
    const negativeHoldout = buildNegativeHoldout();
    setStatus("調整用お手本＋非粒界例を使って範囲ごとの感度を調整中...", 1);
    const calibration = await tuneLocalSensitivity(features, tuningReference, {
      ...currentComparisonOptions(),
      negativeMask: negativeHoldout.tuningMask,
      exclusionMask: state.exclusionMask,
      ...extraction,
      cols: 4,
      rows: 4,
      maxDelta: 18,
      minReferencePixels: 20,
      onProgress: ratio => setStatus(`局所調整中... ${Math.round(ratio * 100)}%`, ratio * 62),
    });
    state.localCalibration = calibration;
    updateLocalCalibrationStatus();

    state.analysisMask = await buildBoundaryMask(features, {
      ...extraction,
      localCalibration: calibration,
      exclusionMask: state.exclusionMask,
      onProgress: ratio => setStatus(`局所補正で再抽出中... ${Math.round(ratio * 100)}%`, 62 + ratio * 36),
    });

    const comparison = renderComparisonOverlay(
      state.analysisMask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentEvaluationOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    els.referenceCanvas.style.visibility = "hidden";
    els.negativeCanvas.style.visibility = "hidden";
    state.comparisonMode = true;
    updateMetrics(comparison.metrics);
    const validationMetrics = split.validationPixels >= 40
      ? computeRegionalMetrics(
        state.analysisMask,
        split.validationMask,
        state.preview.width,
        state.preview.height,
        {
          ...currentComparisonOptions(),
          negativeMask: negativeHoldout.validationMask,
          exclusionMask: state.exclusionMask,
          cols: 4,
          rows: 4,
        },
      )
      : null;
    addHistory(
      "local-tune",
      comparison.metrics,
      validationMetrics
        ? `4x4 partial-label calibration; holdout positiveRecall=${validationMetrics.positiveRecall.toFixed(4)}, negativeLeakage=${validationMetrics.negativeLeakage.toFixed(4)}`
        : "4x4 partial-label calibration; validation holdout unavailable",
    );
    const measured = calibration.measured.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    const validationNote = validationMetrics
      ? ` / 検証 Positive Recall ${(validationMetrics.positiveRecall * 100).toFixed(1)}%`
      : "";
    setStatus(
      `局所調整完了: Positive Recall ${(comparison.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(comparison.metrics.negativeLeakage * 100).toFixed(1)}%${validationNote} / お手本校正 ${measured}/${calibration.cols * calibration.rows}領域`,
      100,
    );
    scheduleAutosave();
  } catch (error) {
    console.error(error);
    setStatus(`局所調整エラー: ${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

function rerenderOverlayOpacity() {
  if (!state.analysisMask || !state.preview) return;
  if (state.comparisonMode && hasReference()) compareCurrent(false);
  else renderNormalOverlay();
}

function bindRange(input, output, onInput = null) {
  input.addEventListener("input", () => {
    output.value = input.value;
    if (onInput) onInput();
  });
}

function setTool(tool) {
  state.tool = tool;
  els.panToolButton.classList.toggle("active", tool === "pan");
  els.referenceToolButton.classList.toggle("active", tool === "reference");
  els.negativeToolButton.classList.toggle("active", tool === "negative-reference");
  els.eraseReferenceToolButton.classList.toggle("active", tool === "erase-reference");
  els.exclusionToolButton.classList.toggle("active", tool === "exclusion");
  els.fullRoiToolButton.classList.toggle("active", tool === "full-roi");
  els.viewer.classList.toggle("reference-mode", tool !== "pan");
  if (state.preview) {
    rebuildExclusionLayer();
    rebuildFullRoiLayer();
  }
}

function eventToPreviewPoint(event) {
  if (!state.preview) return null;
  const rect = els.viewer.getBoundingClientRect();
  const x = ((event.clientX - rect.left) - state.tx) / state.scale;
  const y = ((event.clientY - rect.top) - state.ty) / state.scale;
  if (x < 0 || y < 0 || x >= state.preview.width || y >= state.preview.height) return null;
  return { x, y };
}

function applyLineSegment(layer, tracker, from, to, erase = false) {
  const centerline = layer === "negative" ? state.negativeCenterline : state.referenceCenterline;
  const dirtyBounds = paintReferenceCenterlineSegment(
    centerline,
    state.preview.width,
    state.preview.height,
    from,
    to,
    {
      erase,
      eraseRadius: Math.max(1, referenceJudgementRadius()),
    },
    tracker,
  );
  if (!dirtyBounds) return false;
  if (layer === "negative") refreshNegativeDirty(dirtyBounds);
  else refreshReferenceDirty(dirtyBounds);
  return true;
}

function applyReferenceSegment(from, to) {
  if (!state.currentReferenceEdit) return false;
  let changed = false;

  if (state.tool === "reference") {
    const positiveChanged = applyLineSegment("reference", state.currentReferenceEdit.reference, from, to, false);
    const conflictingNegativeRemoved = applyLineSegment("negative", state.currentReferenceEdit.negative, from, to, true);
    changed = positiveChanged || conflictingNegativeRemoved || changed;
    if (positiveChanged) state.referenceCount = Math.max(1, state.referenceCount);
  } else if (state.tool === "negative-reference") {
    const negativeChanged = applyLineSegment("negative", state.currentReferenceEdit.negative, from, to, false);
    const conflictingPositiveRemoved = applyLineSegment("reference", state.currentReferenceEdit.reference, from, to, true);
    changed = negativeChanged || conflictingPositiveRemoved || changed;
    if (negativeChanged) state.negativeCount = Math.max(1, state.negativeCount);
  } else if (state.tool === "erase-reference") {
    changed = applyLineSegment("reference", state.currentReferenceEdit.reference, from, to, true) || changed;
    changed = applyLineSegment("negative", state.currentReferenceEdit.negative, from, to, true) || changed;
  }

  return changed;
}

function beginReferenceDraw(event) {
  const point = eventToPreviewPoint(event);
  if (!point) return false;
  if (state.comparisonMode) showNormalView();
  invalidateAfterReferenceEdit();

  state.currentReferenceEdit = {
    reference: createReferenceEditTracker(),
    negative: createReferenceEditTracker(),
  };
  state.drawingReference = true;
  state.lastReferencePoint = point;
  applyReferenceSegment(point, point);
  updateAnnotationStatus();
  updateControls();
  els.viewer.setPointerCapture(event.pointerId);
  return true;
}

function continueReferenceDraw(event) {
  if (!state.drawingReference || !state.lastReferencePoint) return;
  const point = eventToPreviewPoint(event);
  if (!point) return;
  applyReferenceSegment(state.lastReferencePoint, point);
  state.lastReferencePoint = point;
}

function endReferenceDraw(event) {
  if (!state.drawingReference) return;
  state.drawingReference = false;
  state.lastReferencePoint = null;

  const parts = [];
  const referenceEntry = finalizeReferenceEdit(
    state.referenceCenterline,
    state.currentReferenceEdit?.reference,
  );
  const negativeEntry = finalizeReferenceEdit(
    state.negativeCenterline,
    state.currentReferenceEdit?.negative,
  );
  if (referenceEntry) parts.push({ layer: "reference", entry: referenceEntry });
  if (negativeEntry) parts.push({ layer: "negative", entry: negativeEntry });
  state.currentReferenceEdit = null;
  if (parts.length) commitReferenceHistory({ kind: "mask-edit", parts });

  recalcAnnotationCounts();
  updateMetrics();
  updateControls();
  setStatus(
    `注釈を更新しました。粒界 ${state.referenceCount.toLocaleString()} px / 非粒界 ${state.negativeCount.toLocaleString()} px`,
  );
  scheduleAutosave();
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}

function beginExclusionDraw(event) {
  const point = eventToPreviewPoint(event);
  if (!point) return false;
  if (state.comparisonMode) showNormalView();
  state.drawingExclusion = true;
  state.exclusionStart = point;
  state.exclusionPreviewRect = normalizeRect(
    point,
    point,
    state.preview.width,
    state.preview.height,
  );
  renderExclusionCanvas(
    els.exclusionCanvas,
    state.exclusionRects,
    state.preview.width,
    state.preview.height,
    state.exclusionPreviewRect,
  );
  els.viewer.setPointerCapture(event.pointerId);
  return true;
}

function continueExclusionDraw(event) {
  if (!state.drawingExclusion || !state.exclusionStart) return;
  const point = eventToPreviewPoint(event);
  if (!point) return;
  state.exclusionPreviewRect = normalizeRect(
    state.exclusionStart,
    point,
    state.preview.width,
    state.preview.height,
  );
  renderExclusionCanvas(
    els.exclusionCanvas,
    state.exclusionRects,
    state.preview.width,
    state.preview.height,
    state.exclusionPreviewRect,
  );
}

function endExclusionDraw(event) {
  if (!state.drawingExclusion) return;
  state.drawingExclusion = false;
  const rect = state.exclusionPreviewRect;
  state.exclusionStart = null;
  state.exclusionPreviewRect = null;

  if (rect && rectArea(rect) >= 9) {
    const index = state.exclusionRects.length;
    state.exclusionRects.push({ ...rect });
    rebuildExclusionLayer();
    invalidateAfterReferenceEdit(true);
    commitReferenceHistory({ kind: "exclusion-add", index, rect: { ...rect } });
    setStatus(`除外領域を追加しました。除外 ${state.exclusionRects.length}領域。再解析してください。`);
    scheduleAutosave();
  } else {
    rebuildExclusionLayer();
  }

  updateControls();
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}

els.fileInput.addEventListener("change", event => loadBmp(event.target.files?.[0]));
els.projectInput.addEventListener("change", event => importProjectFile(event.target.files?.[0]));
els.fitButton.addEventListener("click", fitToViewer);
els.actualButton.addEventListener("click", actualSize);
els.clearOverlayButton.addEventListener("click", clearOverlay);
els.analyzeButton.addEventListener("click", analyzePreview);
els.compareButton.addEventListener("click", () => compareCurrent(true));
els.autoTuneButton.addEventListener("click", autoTune);
els.localTuneButton.addEventListener("click", localTune);
els.clearLocalCalibrationButton.addEventListener("click", () => clearLocalCalibration(false));
els.clearReferenceButton.addEventListener("click", clearReference);
els.clearNegativeButton.addEventListener("click", clearNegativeReference);
els.clearExclusionButton.addEventListener("click", clearExclusions);
els.showNormalButton.addEventListener("click", showNormalView);
els.saveProjectButton.addEventListener("click", saveProjectManual);
els.loadProjectButton.addEventListener("click", () => els.projectInput.click());
els.exportDiagnosticsButton.addEventListener("click", exportDiagnostics);
els.panToolButton.addEventListener("click", () => setTool("pan"));
els.referenceToolButton.addEventListener("click", () => setTool("reference"));
els.negativeToolButton.addEventListener("click", () => setTool("negative-reference"));
els.eraseReferenceToolButton.addEventListener("click", () => setTool("erase-reference"));
els.exclusionToolButton.addEventListener("click", () => setTool("exclusion"));
els.undoReferenceButton.addEventListener("click", undoReference);
els.redoReferenceButton.addEventListener("click", redoReference);

bindRange(els.sensitivity, $("sensitivityValue"), extractionSettingChanged);
bindRange(els.darkWeight, $("darkWeightValue"), extractionSettingChanged);
bindRange(els.ridgeWeight, $("ridgeWeightValue"), extractionSettingChanged);
bindRange(els.colorWeight, $("colorWeightValue"), extractionSettingChanged);
bindRange(els.dendriteWeight, $("dendriteWeightValue"), extractionSettingChanged);
bindRange(els.minComponent, $("minComponentValue"), extractionSettingChanged);
bindRange(els.overlayOpacity, $("overlayOpacityValue"), () => { rerenderOverlayOpacity(); scheduleAutosave(); });
bindRange(els.localStrength, $("localStrengthValue"), featureSettingChanged);
bindRange(els.localWindow, $("localWindowValue"), featureSettingChanged);
bindRange(els.referenceBrush, $("referenceBrushValue"), () => {
  const normalized = normalizedReferenceWidth();
  if (Number(els.referenceBrush.value) !== normalized) setRangeValue(els.referenceBrush, normalized);
  clearLocalCalibration(true);
  if (state.preview && state.referenceCenterline) {
    renderReferenceCanvas();
    renderNegativeCanvas();
    if (state.comparisonMode && state.analysisMask && hasReference()) compareCurrent(false);
    else renderNormalOverlay();
    updateMetrics();
  }
  scheduleAutosave();
});
bindRange(els.referenceOpacity, $("referenceOpacityValue"), () => {
  if (state.preview && state.referenceCenterline) {
    renderReferenceCanvas();
    renderNegativeCanvas();
  }
  scheduleAutosave();
});
bindRange(els.reviewRadius, $("reviewRadiusValue"), scheduleAutosave);
els.localEnabled.addEventListener("change", featureSettingChanged);
els.autosaveEnabled.addEventListener("change", () => { if (els.autosaveEnabled.checked) scheduleAutosave(); else els.projectStatus.textContent = "自動保存OFF"; });

for (const type of ["dragenter", "dragover"]) {
  els.dropZone.addEventListener(type, event => { event.preventDefault(); els.dropZone.classList.add("dragover"); });
}
for (const type of ["dragleave", "drop"]) {
  els.dropZone.addEventListener(type, event => { event.preventDefault(); els.dropZone.classList.remove("dragover"); });
}
els.dropZone.addEventListener("drop", event => {
  const file = [...(event.dataTransfer?.files ?? [])].find(item => item.name.toLowerCase().endsWith(".bmp"));
  if (!file) { setStatus("BMPファイルをドロップしてください。"); return; }
  loadBmp(file);
});

els.viewer.addEventListener("wheel", event => {
  if (!state.preview) return;
  event.preventDefault();
  const rect = els.viewer.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const previous = state.scale;
  state.scale = Math.max(0.02, Math.min(8, state.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
  const imageX = (mx - state.tx) / previous;
  const imageY = (my - state.ty) / previous;
  state.tx = mx - imageX * state.scale;
  state.ty = my - imageY * state.scale;
  applyTransform();
}, { passive: false });

els.viewer.addEventListener("pointerdown", event => {
  if (!state.preview || event.button !== 0) return;
  if (state.tool === "exclusion") { beginExclusionDraw(event); return; }
  if (state.tool !== "pan") { beginReferenceDraw(event); return; }
  state.dragging = true;
  state.dragOrigin = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
  els.viewer.classList.add("dragging");
  els.viewer.setPointerCapture(event.pointerId);
});
els.viewer.addEventListener("pointermove", event => {
  if (state.drawingExclusion) { continueExclusionDraw(event); return; }
  if (state.drawingReference) { continueReferenceDraw(event); return; }
  if (!state.dragging || !state.dragOrigin) return;
  state.tx = state.dragOrigin.tx + event.clientX - state.dragOrigin.x;
  state.ty = state.dragOrigin.ty + event.clientY - state.dragOrigin.y;
  applyTransform();
});
function endPointer(event) {
  if (state.drawingExclusion) endExclusionDraw(event);
  if (state.drawingReference) endReferenceDraw(event);
  if (!state.dragging) return;
  state.dragging = false;
  state.dragOrigin = null;
  els.viewer.classList.remove("dragging");
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) els.viewer.releasePointerCapture(event.pointerId);
}
els.viewer.addEventListener("pointerup", endPointer);
els.viewer.addEventListener("pointercancel", endPointer);

window.addEventListener("keydown", event => {
  if (!state.preview || state.busy || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    if (state.undoStack.length) {
      event.preventDefault();
      undoReference();
    }
    return;
  }
  if (key === "y" || (key === "z" && event.shiftKey)) {
    if (state.redoStack.length) {
      event.preventDefault();
      redoReference();
    }
  }
});

window.addEventListener("resize", () => { if (state.preview) fitToViewer(); });

renderHistory();
els.projectStatus.textContent = `v${APP_VERSION} / ${ALGORITHM_VERSION}`;
updateAnnotationStatus();
updateLocalCalibrationStatus();
updateControls();
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
  featureMapImageData,
  imageDataToBlob,
} from "./diagnostics.js";
import { buildStoredZip } from "./zip.js";
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
import {
  combineNegativeMasks,
  rebuildClosedNegativeMask,
  splitClosedNegativeRegions,
} from "./closed-negative-fill.js";
import {
  computeBoundaryTopology,
  computeClosureProfile,
  computeClosureSnapshot,
  proposeExtendedGapBridges,
  proposeShortGapBridges,
} from "./topology.js";

const $ = id => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  projectInput: $("projectInput"),
  dropZone: $("dropZone"),
  viewer: $("viewer"),
  canvasStage: $("canvasStage"),
  imageCanvas: $("imageCanvas"),
  overlayCanvas: $("overlayCanvas"),
  gapCanvas: $("gapCanvas"),
  fullRoiCanvas: $("fullRoiCanvas"),
  exclusionCanvas: $("exclusionCanvas"),
  negativeCanvas: $("negativeCanvas"),
  referenceCanvas: $("referenceCanvas"),
  emptyState: $("emptyState"),
  panToolButton: $("panToolButton"),
  referenceToolButton: $("referenceToolButton"),
  negativeToolButton: $("negativeToolButton"),
  closedNegativeFillToolButton: $("closedNegativeFillToolButton"),
  eraseReferenceToolButton: $("eraseReferenceToolButton"),
  exclusionToolButton: $("exclusionToolButton"),
  fullRoiToolButton: $("fullRoiToolButton"),
  undoReferenceButton: $("undoReferenceButton"),
  redoReferenceButton: $("redoReferenceButton"),
  fitButton: $("fitButton"),
  actualButton: $("actualButton"),
  clearOverlayButton: $("clearOverlayButton"),
  annotationAssistButton: $("annotationAssistButton"),
  analyzeButton: $("analyzeButton"),
  compareButton: $("compareButton"),
  autoOptimizeButton: $("autoOptimizeButton"),
  autoOptimizeStatus: $("autoOptimizeStatus"),
  precisionGuideButton: $("precisionGuideButton"),
  precisionVerifyButton: $("precisionVerifyButton"),
  precisionSkipButton: $("precisionSkipButton"),
  autoTuneButton: $("autoTuneButton"),
  localTuneButton: $("localTuneButton"),
  clearLocalCalibrationButton: $("clearLocalCalibrationButton"),
  clearReferenceButton: $("clearReferenceButton"),
  clearNegativeButton: $("clearNegativeButton"),
  clearExclusionButton: $("clearExclusionButton"),
  clearFullRoiButton: $("clearFullRoiButton"),
  showNormalButton: $("showNormalButton"),
  topologyButton: $("topologyButton"),
  gapPreviewButton: $("gapPreviewButton"),
  extendedGapPreviewButton: $("extendedGapPreviewButton"),
  gapApplyButton: $("gapApplyButton"),
  gapRevertButton: $("gapRevertButton"),
  gapMaxDistance: $("gapMaxDistance"),
  extendedGapMaxDistance: $("extendedGapMaxDistance"),
  gapAngle: $("gapAngle"),
  gapMinScore: $("gapMinScore"),
  gapStatus: $("gapStatus"),
  saveProjectButton: $("saveProjectButton"),
  loadProjectButton: $("loadProjectButton"),
  exportDiagnosticsButton: $("exportDiagnosticsButton"),
  exportDiagnosticsIndividualButton: $("exportDiagnosticsIndividualButton"),
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
  centerlineNms: $("centerlineNms"),
  overlayOpacity: $("overlayOpacity"),
  localEnabled: $("localEnabled"),
  localStrength: $("localStrength"),
  localWindow: $("localWindow"),
  referenceBrush: $("referenceBrush"),
  referenceOpacity: $("referenceOpacity"),
  borderAssistedFill: $("borderAssistedFill"),
  reviewRadius: $("reviewRadius"),
  metricPositiveRecall: $("metricPositiveRecall"),
  metricNegativeLeakage: $("metricNegativeLeakage"),
  metricMacroNegativeLeakage: $("metricMacroNegativeLeakage"),
  metricAlignment: $("metricAlignment"),
  metricDetail: $("metricDetail"),
  fullRoiMetrics: $("fullRoiMetrics"),
  annotationStatus: $("annotationStatus"),
  localCalibrationStatus: $("localCalibrationStatus"),
  topologyStatus: $("topologyStatus"),
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
  dragPointerId: null,
  dragButton: null,
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
  manualNegativeMask: null,
  negativeCenterline: null,
  negativeCount: 0,
  closedNegativeMask: null,
  borderAssistedNegativeMask: null,
  closedNegativeRegionIndex: null,
  closedNegativeSeeds: [],
  closedNegativeCount: 0,
  borderAssistedNegativeCount: 0,
  borderAssistedSeedCount: 0,
  closedNegativeValidCount: 0,
  closedNegativeInvalidCount: 0,
  closedNegativeDirty: false,
  closedFillRefreshTimer: null,
  closedFillRefreshIdleHandle: null,
  combinedNegativeCount: 0,
  exclusionRects: [],
  exclusionMask: null,
  exclusionPixelCount: 0,
  fullEvaluationRois: [],
  precisionGuide: {
    active: false,
    currentRoiIndex: -1,
    autoRunAfterComplete: false,
    skipForImage: false,
  },
  comparisonMode: false,
  annotationAssist: false,
  overlayPeekHidden: false,
  lastMetrics: null,
  lastTopology: null,
  gapProposal: null,
  gapBaseMask: null,
  gapApplied: null,
  localCalibration: null,
  history: [],
  busy: false,
  abortController: null,
  autosaveTimer: null,
  autosaveIdleHandle: null,
  transformFrame: null,
  performance: {
    featureComputeMs: null,
    boundaryAnalysisMs: null,
    comparisonMs: null,
    autoTuneMs: null,
    autoOptimizeMs: null,
    closedFillRebuildMs: null,
    annotationCommitMs: null,
    autosaveSerializeMs: null,
    autosaveWriteMs: null,
    topologyMs: null,
    gapBridgeMs: null,
  },
};

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function recordPerformance(name, startedAt) {
  state.performance[name] = Math.max(0, nowMs() - startedAt);
  return state.performance[name];
}

function performanceSnapshot() {
  return {
    ...state.performance,
    previewPixels: state.preview ? state.preview.width * state.preview.height : 0,
    closedFillSeedCount: state.closedNegativeSeeds.length,
    borderAssistedFillSeedCount: state.closedNegativeSeeds.filter(seed => seed?.borderAssisted).length,
  };
}

function scheduleTransform() {
  if (state.transformFrame != null) return;
  state.transformFrame = requestAnimationFrame(() => {
    state.transformFrame = null;
    applyTransform();
  });
}

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
  return state.negativeCount > 0 || state.closedNegativeSeeds.length > 0;
}

function hasExclusions() {
  return state.exclusionRects.length > 0;
}

function verifiedFullEvaluationRois() {
  return state.fullEvaluationRois.filter(rect => rect?.verified !== false);
}

function provisionalFullEvaluationRois() {
  return state.fullEvaluationRois.filter(rect => rect?.verified === false);
}

function hasFullEvaluationRois() {
  return verifiedFullEvaluationRois().length > 0;
}

function hasAnyFullEvaluationRois() {
  return state.fullEvaluationRois.length > 0;
}

function updateControls() {
  const hasPreview = Boolean(state.preview);
  const hasAnalysis = Boolean(state.analysisMask);
  const hasRef = hasReference();
  const disabled = state.busy;
  els.fileInput.disabled = disabled;
  els.borderAssistedFill.disabled = disabled || !hasPreview;
  els.analyzeButton.disabled = disabled || !hasPreview;
  els.fitButton.disabled = disabled || !hasPreview;
  els.actualButton.disabled = disabled || !hasPreview;
  els.clearOverlayButton.disabled = disabled || !hasAnalysis;
  els.annotationAssistButton.disabled = disabled || !hasAnalysis;
  els.topologyButton.disabled = disabled || !hasAnalysis;
  els.gapPreviewButton.disabled = disabled || !hasAnalysis;
  els.extendedGapPreviewButton.disabled = disabled || !hasAnalysis;
  els.gapApplyButton.disabled = disabled || !hasAnalysis || !state.gapProposal?.acceptedBridgeCount;
  els.gapRevertButton.disabled = disabled || !hasAnalysis || !state.gapBaseMask;
  els.gapMaxDistance.disabled = disabled || !hasAnalysis;
  els.extendedGapMaxDistance.disabled = disabled || !hasAnalysis;
  els.gapAngle.disabled = disabled || !hasAnalysis;
  els.gapMinScore.disabled = disabled || !hasAnalysis;
  els.panToolButton.disabled = disabled || !hasPreview;
  els.referenceToolButton.disabled = disabled || !hasPreview;
  els.negativeToolButton.disabled = disabled || !hasPreview;
  els.closedNegativeFillToolButton.disabled = disabled || !hasPreview || !hasRef;
  els.eraseReferenceToolButton.disabled = disabled || !hasPreview || (!hasRef && !hasNegativeReference());
  els.exclusionToolButton.disabled = disabled || !hasPreview;
  els.fullRoiToolButton.disabled = disabled || !hasPreview;
  els.undoReferenceButton.disabled = disabled || !hasPreview || state.undoStack.length === 0;
  els.redoReferenceButton.disabled = disabled || !hasPreview || state.redoStack.length === 0;
  els.compareButton.disabled = disabled || !hasAnalysis || !hasRef;
  els.autoOptimizeButton.disabled = disabled || !hasPreview || !hasRef || state.precisionGuide.active;
  els.precisionGuideButton.disabled = disabled || !hasAnalysis || !hasRef || state.precisionGuide.active;
  els.precisionVerifyButton.disabled = disabled || !state.precisionGuide.active;
  els.precisionSkipButton.disabled = disabled || !state.precisionGuide.active;
  els.autoTuneButton.disabled = disabled || !hasPreview || !hasRef;
  els.localTuneButton.disabled = disabled || !hasPreview || !hasRef;
  els.clearLocalCalibrationButton.disabled = disabled || !state.localCalibration;
  els.clearReferenceButton.disabled = disabled || !hasRef;
  els.clearNegativeButton.disabled = disabled || !hasNegativeReference();
  els.clearExclusionButton.disabled = disabled || !hasExclusions();
  els.clearFullRoiButton.disabled = disabled || !hasAnyFullEvaluationRois();
  els.showNormalButton.disabled = disabled || !state.comparisonMode;
  els.saveProjectButton.disabled = disabled || !hasPreview || !state.sourceFingerprint;
  els.loadProjectButton.disabled = disabled || !hasPreview;
  els.exportDiagnosticsButton.disabled = disabled || !hasPreview || !hasAnalysis || !hasRef;
  els.exportDiagnosticsIndividualButton.disabled = disabled || !hasPreview || !hasAnalysis || !hasRef;
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
  for (const canvas of [els.imageCanvas, els.overlayCanvas, els.gapCanvas, els.fullRoiCanvas, els.exclusionCanvas, els.negativeCanvas, els.referenceCanvas]) {
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
    centerlineNms: els.centerlineNms.checked,
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
  if (!state.preview || !hasNegativeReference()) {
    return {
      tuningMask: null,
      validationMask: null,
      tuningPixels: 0,
      validationPixels: 0,
      mode: "no-negative-labels",
      manualSplit: null,
      closedSplit: null,
    };
  }

  const width = state.preview.width;
  const height = state.preview.height;
  const radius = referenceJudgementRadius();

  let manualTuning = null;
  let manualValidation = null;
  let manualSplit = null;
  if (state.negativeCenterline && state.negativeCount > 0) {
    manualSplit = splitReferenceCenterline(
      state.negativeCenterline,
      width,
      height,
      { validationFraction: 0.20, minComponentPixels: 8 },
    );
    if (manualSplit.validationPixels >= 20) {
      manualTuning = dilateBinaryMask(manualSplit.tuneMask, width, height, radius);
      manualValidation = dilateBinaryMask(manualSplit.validationMask, width, height, radius);
    } else {
      manualTuning = state.manualNegativeMask;
    }
  }

  let closedSplit = null;
  let closedTuning = null;
  let closedValidation = null;
  if (state.closedNegativeSeeds.length > 0 && state.referenceMask) {
    closedSplit = splitClosedNegativeRegions(
      state.referenceMask,
      width,
      height,
      state.closedNegativeSeeds,
      {
        ...closedNegativeFillOptions(),
        validationFraction: 0.20,
      },
      state.closedNegativeRegionIndex,
    );
    state.closedNegativeRegionIndex = closedSplit.regionIndex ?? state.closedNegativeRegionIndex;
    if (closedSplit.validationRegionCount > 0 && closedSplit.validationPixels > 0) {
      closedTuning = closedSplit.tuningMask;
      closedValidation = closedSplit.validationMask;
    } else {
      closedTuning = state.closedNegativeMask;
    }
  }

  const tuningMask = combineNegativeMasks(
    manualTuning,
    closedTuning,
    state.referenceMask,
  );
  const validationCombined = combineNegativeMasks(
    manualValidation,
    closedValidation,
    state.referenceMask,
  );
  const tuningPixels = countMaskPixels(tuningMask);
  const validationPixels = countMaskPixels(validationCombined);
  const validationMask = validationPixels >= 20 ? validationCombined : null;

  return {
    tuningMask: tuningPixels ? tuningMask : state.negativeMask,
    validationMask,
    tuningPixels,
    validationPixels: validationMask ? validationPixels : 0,
    mode: validationMask ? "independent-region-holdout" : "validation-unavailable",
    manualSplit,
    closedSplit,
    summary: {
      manualComponentCount: manualSplit?.componentCount ?? 0,
      manualValidationPixels: manualValidation ? countMaskPixels(manualValidation) : 0,
      closedRegionCount: closedSplit?.regionCount ?? 0,
      closedTuningRegionCount: closedSplit?.tuningRegionCount ?? 0,
      closedValidationRegionCount: closedSplit?.validationRegionCount ?? 0,
      closedTuningPixels: closedSplit?.tuningPixels ?? (closedTuning ? countMaskPixels(closedTuning) : 0),
      closedValidationPixels: closedSplit?.validationPixels ?? 0,
    },
  };
}
function currentBoundaryOptions() {
  return {
    ...currentExtractionOptions(),
    localCalibration: state.localCalibration,
    exclusionMask: state.exclusionMask,
    edgeFrameGuard: 1,
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
    borderAssistedFill: els.borderAssistedFill.checked,
    gapBridge: {
      maxDistance: Number(els.gapMaxDistance.value),
      extendedMaxDistance: Number(els.extendedGapMaxDistance.value),
      maxAngleDeg: Number(els.gapAngle.value),
      minScore: Number(els.gapMinScore.value) / 100,
      negativeGuardRadius: 1,
    },
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
  els.centerlineNms.checked = extraction.centerlineNms == null ? true : Boolean(extraction.centerlineNms);
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
  if (settings.borderAssistedFill != null) els.borderAssistedFill.checked = Boolean(settings.borderAssistedFill);
  const gapBridge = settings.gapBridge ?? {};
  if (gapBridge.maxDistance != null) {
    els.gapMaxDistance.value = String(gapBridge.maxDistance);
    $("gapMaxDistanceValue").value = els.gapMaxDistance.value;
  }
  if (gapBridge.extendedMaxDistance != null) {
    els.extendedGapMaxDistance.value = String(gapBridge.extendedMaxDistance);
    $("extendedGapMaxDistanceValue").value = els.extendedGapMaxDistance.value;
  }
  if (gapBridge.maxAngleDeg != null) setRangeValue(els.gapAngle, gapBridge.maxAngleDeg);
  if (gapBridge.minScore != null) {
    setRangeValue(
      els.gapMinScore,
      gapBridge.minScore <= 1 ? gapBridge.minScore * 100 : gapBridge.minScore,
    );
  }
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
    resetGapBridgeState(true);
    state.analysisMask = null;
    invalidateTopology();
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

function applyAnnotationAssistView() {
  els.annotationAssistButton?.classList.toggle("active", state.annotationAssist);
  if (els.overlayCanvas) {
    els.overlayCanvas.style.opacity = state.annotationAssist ? "0.32" : "1";
    els.overlayCanvas.style.visibility = state.overlayPeekHidden ? "hidden" : "visible";
  }
  if (els.gapCanvas) els.gapCanvas.style.opacity = state.annotationAssist ? "0.88" : "1";
  if (els.negativeCanvas) els.negativeCanvas.style.opacity = state.annotationAssist ? "0.22" : "1";
  if (els.exclusionCanvas) els.exclusionCanvas.style.opacity = state.annotationAssist ? "0.58" : "1";
  if (els.fullRoiCanvas) els.fullRoiCanvas.style.opacity = state.annotationAssist ? "0.78" : "1";
}

function toggleAnnotationAssist(force = null, announce = true) {
  state.annotationAssist = force == null ? !state.annotationAssist : Boolean(force);
  applyAnnotationAssistView();
  if (announce) {
    setStatus(state.annotationAssist
      ? "お手本作成表示: 自動境界と非粒界Fillを薄く表示します。Hを押している間は自動境界を隠せます。"
      : "通常のオーバーレイ濃度に戻しました。");
  }
}

function setOverlayPeekHidden(hidden) {
  state.overlayPeekHidden = Boolean(hidden);
  applyAnnotationAssistView();
}


function clearGapProposal() {
  state.gapProposal = null;
  if (els.gapCanvas && state.preview) {
    els.gapCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  }
  if (els.gapStatus && !state.gapApplied) {
    els.gapStatus.textContent = "Gap Bridge: 未プレビュー";
  }
}

function resetGapBridgeState(clearApplied = true) {
  clearGapProposal();
  if (clearApplied) {
    state.gapBaseMask = null;
    state.gapApplied = null;
    if (els.gapStatus) els.gapStatus.textContent = "Gap Bridge: 未プレビュー";
  }
}

function invalidateTopology() {
  state.lastTopology = null;
  clearGapProposal();
  if (els.topologyStatus) els.topologyStatus.textContent = "Topology v3.0: 未実行";
}

function topologyRateText(value) {
  return value == null ? "-" : (value * 100).toFixed(1) + "%";
}

function currentGapBridgeOptions() {
  return {
    gapApplyMaxDistance: Number(els.gapMaxDistance.value),
    extendedGapMaxDistance: Number(els.extendedGapMaxDistance.value),
    maxGapAngleDeg: Number(els.gapAngle.value),
    minGapScore: Number(els.gapMinScore.value) / 100,
    extendedMinGapScore: 0.58,
    extendedMinPathEvidence: 0.34,
    negativeGuardRadius: 1,
    maxAcceptedBridges: 400,
    maxExtendedBridges: 240,
    maxGapProposalCandidates: 2400,
    maxGapReviewCandidates: 480,
  };
}

function closureDiagnosticOptions() {
  return {
    closedNegativeMask: state.closedNegativeMask,
    borderAssistedMask: state.borderAssistedNegativeMask,
    coreErosionRadius: 2,
    minCorePixels: 12,
    maxBorderLeakAreaRatio: 2.0,
  };
}

function updateTopologyStatus(result = state.lastTopology) {
  if (!els.topologyStatus) return;
  if (!result) {
    els.topologyStatus.textContent = "Topology v3.0: 未実行";
    return;
  }
  const closure = result.regionClosure;
  const r0 = closure?.closureByBridgeRadius?.find(item => item.bridgeRadius === 0);
  const r2 = closure?.closureByBridgeRadius?.find(item => item.bridgeRadius === 2);
  const r3 = closure?.closureByBridgeRadius?.find(item => item.bridgeRadius === 3);
  const profile = closure?.profile;
  const endpoint = result.endpointProxy;
  const gap = result.shortGapCandidates;
  const safe = result.safeGapBridge;
  const extended = result.extendedGapBridge;
  const regionCount = closure?.coreRegionCount || r0?.regionCount || 0;
  const label = closure?.basis === "closed-negative-eroded-core" ? "Core Closure" : "Seed Closure";
  const closureText = regionCount
    ? label + " 0px " + topologyRateText(r0?.closureRate)
      + " / 2px " + topologyRateText(r2?.closureRate)
      + " / 3px " + topologyRateText(r3?.closureRate)
    : label + ": 評価領域なし";
  const coverageText = r2?.coveredCorePixelFraction
    ? " / Core被覆@2px " + topologyRateText(r2.coveredCorePixelFraction)
    : "";
  const profileText = profile?.regionCount
    ? " / Profile " + topologyRateText(profile.weightedClosureScore)
      + " / 平均必要半径≤" + (profile.maxRadius + 1) + "px " + profile.meanRequiredRadiusCapped.toFixed(2) + "px"
      + " / Open@" + profile.maxRadius + " " + profile.openAfterMaxRadius
    : "";
  const borderText = (r0?.borderAssistedRegions ?? 0)
    ? " / 端部Core " + (r0.borderAssistedClosedRegions ?? 0) + "/" + r0.borderAssistedRegions
      + " (単辺 " + (r0.borderAssistedSingleEdgeRegions ?? 0)
      + ", corner " + (r0.borderAssistedCornerRegions ?? 0)
      + ", 別辺Leak " + (r0.borderAssistedUnexpectedEdgeLeaks ?? 0) + ")"
    : "";
  const gapText = gap
    ? " / Short-gap候補 " + gap.candidateCount.toLocaleString() + "件"
    : "";
  const safeText = safe
    ? " / Safe " + safe.acceptedBridgeCount.toLocaleString()
      + "本・+" + safe.addedPixels.toLocaleString() + "px"
    : "";
  const extendedText = extended
    ? " / Extended " + extended.acceptedBridgeCount.toLocaleString()
      + "本・+" + extended.addedPixels.toLocaleString() + "px"
    : "";
  const endpointText = endpoint?.endpointPixels?.toLocaleString?.()
    ?? endpoint?.endpointPixels
    ?? 0;
  els.topologyStatus.textContent =
    "Topology v3.0: " + closureText + profileText + coverageText + borderText + gapText + safeText + extendedText
    + " / Endpoint proxy " + endpointText;
}

function topologyOptions() {
  return {
    bridgeRadii: [0, 1, 2, 3],
    endpointEdgeMargin: 3,
    ...closureDiagnosticOptions(),
    negativeMask: state.negativeMask,
    exclusionMask: state.exclusionMask,
    maxGapDistance: 4.25,
    maxGapCandidates: 120,
    boundaryEvidence: state.features ? {
      ridge: state.features.ridge,
      color: state.features.color,
    } : null,
    ...currentGapBridgeOptions(),
  };
}

function gapDispositionColor(disposition) {
  if (disposition === "accepted-safe" || disposition === "safe-range") return "#35d07f";
  if (disposition === "accepted-extended") return "#f2c94c";
  if (disposition === "rejected-negative" || disposition === "rejected-exclusion") return "#ff5d5d";
  if (disposition === "rejected-angle") return "#b36cff";
  if (disposition === "rejected-distance") return "#9aa4b2";
  return "#ff9f43";
}

function renderGapProposal(proposal) {
  if (!state.preview || !els.gapCanvas) return;
  const ctx = els.gapCanvas.getContext("2d");
  ctx.clearRect(0, 0, state.preview.width, state.preview.height);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 1.6;
  for (const candidate of proposal?.reviewCandidates ?? []) {
    ctx.strokeStyle = gapDispositionColor(candidate.disposition);
    ctx.globalAlpha = candidate.disposition?.startsWith("accepted") || candidate.disposition === "safe-range"
      ? 0.98
      : 0.78;
    ctx.beginPath();
    ctx.moveTo(candidate.x1 + 0.5, candidate.y1 + 0.5);
    ctx.lineTo(candidate.x2 + 0.5, candidate.y2 + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function compactGapClosure(snapshot) {
  if (!snapshot) return null;
  return {
    basis: snapshot.basis,
    regionCount: snapshot.regionCount ?? snapshot.coreRegionCount ?? 0,
    closedRegions: snapshot.closedRegions ?? 0,
    openRegions: snapshot.openRegions ?? 0,
    closureRate: snapshot.closureRate ?? null,
    borderAssistedRegions: snapshot.borderAssistedRegions ?? 0,
    borderAssistedClosedRegions: snapshot.borderAssistedClosedRegions ?? 0,
    borderAssistedOpenRegions: snapshot.borderAssistedOpenRegions ?? 0,
    borderAssistedSingleEdgeRegions: snapshot.borderAssistedSingleEdgeRegions ?? 0,
    borderAssistedCornerRegions: snapshot.borderAssistedCornerRegions ?? 0,
    borderAssistedUnexpectedEdgeLeaks: snapshot.borderAssistedUnexpectedEdgeLeaks ?? 0,
    borderAssistedOversizeLeaks: snapshot.borderAssistedOversizeLeaks ?? 0,
  };
}

function topologyDeltaFromSnapshots(before, after) {
  if (!before || !after) return null;
  return {
    closedRegions: (after.closedRegions ?? 0) - (before.closedRegions ?? 0),
    openRegions: (after.openRegions ?? 0) - (before.openRegions ?? 0),
    closureRate: (after.closureRate ?? 0) - (before.closureRate ?? 0),
    borderAssistedClosedRegions:
      (after.borderAssistedClosedRegions ?? 0) - (before.borderAssistedClosedRegions ?? 0),
  };
}

function evaluateGapTopology(maskAfter) {
  if (!state.preview || !state.analysisMask || !maskAfter) return null;
  const options = closureDiagnosticOptions();
  const before = computeClosureSnapshot(
    state.analysisMask,
    state.preview.width,
    state.preview.height,
    state.closedNegativeSeeds,
    options,
  );
  const after = computeClosureSnapshot(
    maskAfter,
    state.preview.width,
    state.preview.height,
    state.closedNegativeSeeds,
    options,
  );
  const compactBefore = compactGapClosure(before);
  const compactAfter = compactGapClosure(after);
  return {
    before: compactBefore,
    after: compactAfter,
    delta: topologyDeltaFromSnapshots(compactBefore, compactAfter),
  };
}

function gapMetricsText(before, after) {
  if (!before || !after) return "";
  const recallDelta = (after.positiveRecall - before.positiveRecall) * 100;
  const leakDelta = (after.negativeLeakage - before.negativeLeakage) * 100;
  const signed = value => (value >= 0 ? "+" : "") + value.toFixed(2) + "pt";
  return " / Recall " + (before.positiveRecall * 100).toFixed(1)
    + "→" + (after.positiveRecall * 100).toFixed(1) + "% (" + signed(recallDelta) + ")"
    + " / Leak " + (before.negativeLeakage * 100).toFixed(1)
    + "→" + (after.negativeLeakage * 100).toFixed(1) + "% (" + signed(leakDelta) + ")";
}

function gapTopologyText(topology) {
  if (!topology?.before || !topology?.after) return "";
  const delta = topology.delta ?? {};
  const signed = value => (value >= 0 ? "+" : "") + value;
  return " / Closure " + topologyRateText(topology.before.closureRate)
    + "→" + topologyRateText(topology.after.closureRate)
    + " / 閉領域 " + topology.before.closedRegions + "→" + topology.after.closedRegions
    + " (" + signed(delta.closedRegions ?? 0) + ")";
}

function gapReviewCount(proposal, disposition) {
  return (proposal?.reviewCandidates ?? []).reduce(
    (sum, item) => sum + (item.disposition === disposition ? 1 : 0),
    0,
  );
}

async function previewGapBridges(mode = "safe") {
  if (!state.preview || !state.analysisMask) return null;
  ensureClosedNegativeFresh();
  setBusy(true);
  try {
    const extended = mode === "extended";
    setStatus((extended ? "Extended Gap" : "Safe Gap") + "候補を評価中...", 20);
    if (extended) await ensureFeatures();
    await new Promise(resolve => setTimeout(resolve, 0));
    const startedAt = nowMs();
    const proposal = extended
      ? proposeExtendedGapBridges(
        state.analysisMask,
        state.preview.width,
        state.preview.height,
        topologyOptions(),
      )
      : proposeShortGapBridges(
        state.analysisMask,
        state.preview.width,
        state.preview.height,
        topologyOptions(),
      );
    recordPerformance("gapBridgeMs", startedAt);
    state.gapProposal = proposal;
    renderGapProposal(proposal);

    let beforeMetrics = null;
    let afterMetrics = null;
    if (hasReference()) {
      const evaluationOptions = {
        ...currentComparisonOptions(),
        negativeMask: state.negativeMask,
        exclusionMask: state.exclusionMask,
        cols: 4,
        rows: 4,
      };
      beforeMetrics = computeRegionalMetrics(
        state.analysisMask,
        state.referenceCenterline,
        state.preview.width,
        state.preview.height,
        evaluationOptions,
      );
      afterMetrics = computeRegionalMetrics(
        proposal.mask,
        state.referenceCenterline,
        state.preview.width,
        state.preview.height,
        evaluationOptions,
      );
    }

    proposal.evaluation = beforeMetrics && afterMetrics ? {
      before: {
        positiveRecall: beforeMetrics.positiveRecall,
        negativeLeakage: beforeMetrics.negativeLeakage,
        macroNegativeLeakage: beforeMetrics.macroNegativeLeakage,
      },
      after: {
        positiveRecall: afterMetrics.positiveRecall,
        negativeLeakage: afterMetrics.negativeLeakage,
        macroNegativeLeakage: afterMetrics.macroNegativeLeakage,
      },
    } : null;
    proposal.topology = evaluateGapTopology(proposal.mask);

    const rejected = proposal.rejected ?? {};
    const label = extended ? "Extended Gap" : "Safe Gap";
    const angleRejected = gapReviewCount(proposal, "rejected-angle");
    const detail =
      "候補 " + proposal.sourceCandidateCount.toLocaleString() + "件"
      + " → 適用候補 " + proposal.acceptedBridgeCount.toLocaleString() + "本"
      + " / 追加 " + proposal.addedPixels.toLocaleString() + "px"
      + " / Reject: Negative " + (rejected.negative ?? 0)
      + ", 除外 " + (rejected.exclusion ?? 0)
      + ", 角度 " + angleRejected
      + ", Score " + (rejected.score ?? 0)
      + (extended ? ", Evidence " + ((rejected.evidence ?? 0) + (rejected.evidenceUnavailable ?? 0)) : "")
      + ", 距離 " + (rejected.distance ?? 0);
    els.gapStatus.textContent =
      label + ": " + detail
      + gapMetricsText(beforeMetrics, afterMetrics)
      + gapTopologyText(proposal.topology);
    setStatus(
      label + "プレビュー完了: " + detail
        + gapTopologyText(proposal.topology)
        + " / " + state.performance.gapBridgeMs.toFixed(0) + " ms",
      100,
    );
    updateControls();
    return proposal;
  } catch (error) {
    console.error(error);
    setStatus("Gap Bridgeエラー: " + error.message, 0);
    return null;
  } finally {
    setBusy(false);
  }
}

async function previewSafeGapBridges() {
  return previewGapBridges("safe");
}

async function previewExtendedGapBridges() {
  return previewGapBridges("extended");
}

async function applyGapBridges() {
  if (!state.preview || !state.analysisMask) return;
  let proposal = state.gapProposal;
  if (!proposal) proposal = await previewSafeGapBridges();
  if (!proposal?.acceptedBridgeCount) {
    setStatus("適用できるGap候補がありません。");
    return;
  }

  const wasComparison = state.comparisonMode;
  if (!state.gapBaseMask) state.gapBaseMask = state.analysisMask.slice();
  state.analysisMask = proposal.mask;
  const previousApplied = state.gapApplied;
  const label = proposal.mode === "extended" ? "Extended Gap" : "Safe Gap";
  const application = {
    mode: proposal.mode ?? "safe",
    appliedAt: new Date().toISOString(),
    bridgeCount: proposal.acceptedBridgeCount,
    addedPixels: proposal.addedPixels,
    settings: proposal.settings,
    rejected: proposal.rejected,
    sourceCandidateCount: proposal.sourceCandidateCount,
    evaluation: proposal.evaluation ?? null,
    topology: proposal.topology ?? null,
  };
  const topologyBefore = previousApplied?.topologyBefore ?? proposal.topology?.before ?? null;
  const topologyAfter = proposal.topology?.after ?? previousApplied?.topologyAfter ?? null;
  state.gapApplied = {
    mode: previousApplied && previousApplied.mode !== application.mode ? "mixed" : application.mode,
    appliedAt: application.appliedAt,
    passes: (previousApplied?.passes ?? 0) + 1,
    bridgeCount: (previousApplied?.bridgeCount ?? 0) + proposal.acceptedBridgeCount,
    addedPixels: (previousApplied?.addedPixels ?? 0) + proposal.addedPixels,
    safeBridgeCount: (previousApplied?.safeBridgeCount ?? 0)
      + (application.mode === "safe" ? proposal.acceptedBridgeCount : 0),
    extendedBridgeCount: (previousApplied?.extendedBridgeCount ?? 0)
      + (application.mode === "extended" ? proposal.acceptedBridgeCount : 0),
    topologyBefore,
    topologyAfter,
    topologyDelta: topologyDeltaFromSnapshots(topologyBefore, topologyAfter),
    applications: [...(previousApplied?.applications ?? []), application],
    settings: proposal.settings,
    rejected: proposal.rejected,
    sourceCandidateCount: proposal.sourceCandidateCount,
    evaluation: proposal.evaluation ?? null,
  };
  state.gapProposal = null;
  els.gapCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  state.lastTopology = null;
  els.topologyStatus.textContent = "Topology v3.0: Gap適用後は未再診断";

  if (wasComparison && hasReference()) {
    compareCurrent(false);
  } else {
    renderNormalOverlay();
    updateMetrics();
  }
  els.gapStatus.textContent =
    "Gap Bridge: 適用済み " + state.gapApplied.bridgeCount.toLocaleString()
      + "本 (Safe " + state.gapApplied.safeBridgeCount.toLocaleString()
      + " / Extended " + state.gapApplied.extendedBridgeCount.toLocaleString() + ")"
      + " / +" + state.gapApplied.addedPixels.toLocaleString()
      + "px" + gapTopologyText({
        before: state.gapApplied.topologyBefore,
        after: state.gapApplied.topologyAfter,
        delta: state.gapApplied.topologyDelta,
      })
      + "（「Gap適用を戻す」で抽出直後へ復帰）";
  updateControls();
  setStatus(
    label + "を適用しました: " + proposal.acceptedBridgeCount.toLocaleString()
      + "本 / +" + proposal.addedPixels.toLocaleString()
      + "px。必要ならTopologyを再診断してください。",
    100,
  );
}

function revertGapBridges() {
  if (!state.preview || !state.gapBaseMask) return;
  const wasComparison = state.comparisonMode;
  state.analysisMask = state.gapBaseMask;
  state.gapBaseMask = null;
  state.gapApplied = null;
  state.gapProposal = null;
  els.gapCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  state.lastTopology = null;
  els.topologyStatus.textContent = "Topology v3.0: Gap復帰後は未再診断";
  els.gapStatus.textContent = "Gap Bridge: 適用を戻しました";

  if (wasComparison && hasReference()) {
    compareCurrent(false);
  } else {
    renderNormalOverlay();
    updateMetrics();
  }
  updateControls();
  setStatus("Gap適用前の粒界マスクへ戻しました。", 100);
}

async function runTopologyDiagnostics() {
  if (!state.preview || !state.analysisMask) return null;
  ensureClosedNegativeFresh();
  setBusy(true);
  try {
    if (!state.features) await ensureFeatures();
    setStatus("Topology v3.0診断中... Core閉鎖・画像端・Safe/Extended Gapを確認しています。", 10);
    await new Promise(resolve => setTimeout(resolve, 0));
    const startedAt = nowMs();
    const result = computeBoundaryTopology(
      state.analysisMask,
      state.preview.width,
      state.preview.height,
      state.closedNegativeSeeds,
      topologyOptions(),
    );
    recordPerformance("topologyMs", startedAt);
    state.lastTopology = result;
    updateTopologyStatus(result);
    const closure = result.regionClosure;
    const r0 = closure.closureByBridgeRadius.find(item => item.bridgeRadius === 0);
    const r2 = closure.closureByBridgeRadius.find(item => item.bridgeRadius === 2);
    const basis = closure.basis === "closed-negative-eroded-core" ? "Core Closure" : "Seed Closure";
    const gapCount = result.shortGapCandidates?.candidateCount ?? 0;
    const safeCount = result.safeGapBridge?.acceptedBridgeCount ?? 0;
    const extendedCount = result.extendedGapBridge?.acceptedBridgeCount ?? 0;
    setStatus(
      "Topology v3.0完了: " + basis
        + " 0px " + topologyRateText(r0?.closureRate)
        + " → 2px " + topologyRateText(r2?.closureRate)
        + " / Short-gap " + gapCount.toLocaleString() + "件"
        + " / Safe " + safeCount.toLocaleString() + "本"
        + " / Extended " + extendedCount.toLocaleString() + "本"
        + " / Endpoint proxy " + result.endpointProxy.endpointPixels.toLocaleString()
        + " / " + state.performance.topologyMs.toFixed(0) + " ms",
      100,
    );
    return result;
  } catch (error) {
    console.error(error);
    setStatus("Topology診断エラー: " + error.message, 0);
    return null;
  } finally {
    setBusy(false);
  }
}
function updateMetrics(metrics = null) {
  state.lastMetrics = metrics;
  if (!metrics) {
    els.metricPositiveRecall.textContent = "-";
    els.metricNegativeLeakage.textContent = "-";
    els.metricMacroNegativeLeakage.textContent = "-";
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
  els.metricMacroNegativeLeakage.textContent = `${((metrics.macroNegativeLeakage ?? metrics.negativeLeakage) * 100).toFixed(1)}%`;
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
      verifiedFullEvaluationRois(),
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
    const macroNegativeLeakage = item.metrics?.macroNegativeLeakage ?? negativeLeakage;
    const recallText = positiveRecall == null ? "-" : `${(positiveRecall * 100).toFixed(1)}%`;
    const leakText = negativeLeakage == null ? "-" : `${(negativeLeakage * 100).toFixed(1)}%`;
    const macroLeakText = macroNegativeLeakage == null ? "-" : `${(macroNegativeLeakage * 100).toFixed(1)}%`;
    const label = item.kind === "auto-optimize"
      ? "自動最適化"
      : item.kind === "auto-tune"
        ? "全体調整"
        : item.kind === "local-tune"
          ? "局所調整"
          : "比較";
    li.innerHTML = `<strong>${label}</strong><span>R ${recallText} / Leak ${leakText} / Macro ${macroLeakText}</span><small>${date.toLocaleString("ja-JP")}</small>`;
    els.historyList.appendChild(li);
  }
}

function compactAutoTuneSearch(search) {
  if (!search) return null;
  return {
    version: search.version ?? 4,
    strategy: search.strategy ?? "coordinate-descent-processed-guard-with-topology-diagnostics",
    objectiveMode: search.objectiveMode ?? null,
    coordinateEvaluation: search.coordinateEvaluation ?? null,
    processedEvaluation: search.processedEvaluation ?? null,
    ablationEvaluation: search.ablationEvaluation ?? null,
    topologyEvaluation: search.topologyEvaluation ?? null,
    topology: search.topology ?? null,
    baseline: search.baseline ?? null,
    final: search.final ?? null,
    rounds: (search.rounds ?? []).map(round => ({
      round: round.round,
      startParameters: round.startParameters,
      accepted: round.accepted,
      revertedTo: round.revertedTo ?? null,
      processed: round.processed ?? null,
      coordinates: (round.coordinates ?? []).map(item => ({
        name: item.name,
        previousValue: item.previousValue,
        rawSelectedValue: item.rawSelectedValue ?? item.selectedValue,
        selectedValue: item.selectedValue,
        acceptedByProcessed: item.acceptedByProcessed ?? null,
        processedObjective: item.processedObjective ?? null,
      })),
    })),
    ablation: search.ablation ?? [],
  };
}

function addHistory(kind, metrics, note = "", tuning = null) {
  const cleanRegions = (metrics.regions ?? []).map(region => ({
    rx: region.rx, ry: region.ry, precision: region.precision, recall: region.recall,
    f1: region.f1, referencePixels: region.referencePixels,
    negativePixels: region.negativePixels ?? 0,
    negativePrediction: region.negativePrediction ?? 0,
    negativeLeakage: region.negativeLeakage ?? 0,
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
      macroNegativeLeakage: metrics.macroNegativeLeakage ?? metrics.negativeLeakage ?? 0,
      negativeRegionCount: metrics.negativeRegionCount ?? 0,
      maxNegativeRegionShare: metrics.maxNegativeRegionShare ?? 0,
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
    tuning,
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
  applyAnnotationAssistView();
  updateControls();
}

function renderReferenceCanvas(rebuildMask = true) {
  if (!state.preview || !state.referenceCenterline) return;
  if (rebuildMask) {
    state.referenceMask = dilateBinaryMask(
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      referenceJudgementRadius(),
    );
    state.closedNegativeRegionIndex = null;
    state.closedNegativeDirty = state.closedNegativeSeeds.length > 0;
  }
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

function closedNegativeFillOptions() {
  return {
    safetyRadius: 3,
    maxAreaFraction: 0.35,
    borderMaxAreaFraction: 0.12,
    maxBorderSides: 2,
    minBorderReferenceContactPixels: 8,
    minPixels: 12,
  };
}

function rebuildClosedNegativeState() {
  if (!state.preview || !state.referenceMask) return null;
  if (!state.closedNegativeSeeds.length) {
    if (!state.closedNegativeMask || state.closedNegativeMask.length !== state.preview.width * state.preview.height) {
      state.closedNegativeMask = new Uint8Array(state.preview.width * state.preview.height);
    } else {
      state.closedNegativeMask.fill(0);
    }
    if (!state.borderAssistedNegativeMask || state.borderAssistedNegativeMask.length !== state.preview.width * state.preview.height) {
      state.borderAssistedNegativeMask = new Uint8Array(state.preview.width * state.preview.height);
    } else {
      state.borderAssistedNegativeMask.fill(0);
    }
    state.closedNegativeCount = 0;
    state.borderAssistedNegativeCount = 0;
    state.borderAssistedSeedCount = 0;
    state.closedNegativeValidCount = 0;
    state.closedNegativeInvalidCount = 0;
    state.closedNegativeDirty = false;
    state.performance.closedFillRebuildMs = 0;
    return null;
  }

  const startedAt = nowMs();
  const rebuilt = rebuildClosedNegativeMask(
    state.referenceMask,
    state.preview.width,
    state.preview.height,
    state.closedNegativeSeeds,
    closedNegativeFillOptions(),
    state.closedNegativeRegionIndex,
  );
  state.closedNegativeRegionIndex = rebuilt.regionIndex ?? null;
  state.closedNegativeMask = rebuilt.mask;
  state.borderAssistedNegativeMask = rebuilt.borderAssistedMask ?? new Uint8Array(state.preview.width * state.preview.height);
  state.closedNegativeCount = rebuilt.fillPixels ?? countMaskPixels(rebuilt.mask);
  state.borderAssistedNegativeCount = rebuilt.borderAssistedPixels ?? countMaskPixels(state.borderAssistedNegativeMask);
  state.borderAssistedSeedCount = rebuilt.borderAssistedCount ?? 0;
  state.closedNegativeValidCount = rebuilt.validCount;
  state.closedNegativeInvalidCount = rebuilt.invalidCount;
  state.closedNegativeDirty = false;
  state.performance.closedFillRebuildMs = rebuilt.elapsedMs ?? recordPerformance("closedFillRebuildMs", startedAt);
  return rebuilt;
}

function cancelScheduledClosedFillRefresh() {
  clearTimeout(state.closedFillRefreshTimer);
  state.closedFillRefreshTimer = null;
  if (state.closedFillRefreshIdleHandle != null) {
    if ("cancelIdleCallback" in window) window.cancelIdleCallback(state.closedFillRefreshIdleHandle);
    else clearTimeout(state.closedFillRefreshIdleHandle);
  }
  state.closedFillRefreshIdleHandle = null;
}

function refreshClosedFillNow() {
  cancelScheduledClosedFillRefresh();
  if (!state.closedNegativeDirty || !state.preview) return;
  rebuildClosedNegativeState();
  rebuildCombinedNegativeMask();
  renderBinaryMaskCanvas(
    els.negativeCanvas,
    state.negativeMask,
    state.preview.width,
    state.preview.height,
    referenceOpacityRatio(),
    [255, 138, 0],
  );
  updateAnnotationStatus();
}

function scheduleClosedFillRefresh() {
  cancelScheduledClosedFillRefresh();
  if (!state.closedNegativeDirty || !state.closedNegativeSeeds.length || !state.preview) return;
  state.closedFillRefreshTimer = setTimeout(() => {
    state.closedFillRefreshTimer = null;
    const run = () => {
      state.closedFillRefreshIdleHandle = null;
      if (!state.closedNegativeDirty) return;
      if (state.drawingReference || state.dragging || state.rectInteraction || state.busy) {
        scheduleClosedFillRefresh();
        return;
      }
      refreshClosedFillNow();
    };
    if ("requestIdleCallback" in window) {
      state.closedFillRefreshIdleHandle = window.requestIdleCallback(run, { timeout: 1200 });
    } else {
      state.closedFillRefreshIdleHandle = setTimeout(run, 0);
    }
  }, 80);
}

function ensureClosedNegativeFresh() {
  if (state.closedNegativeDirty) refreshClosedFillNow();
}

function rebuildCombinedNegativeMask() {
  if (!state.preview) return;
  state.negativeMask = combineNegativeMasks(
    state.manualNegativeMask,
    state.closedNegativeMask,
    state.referenceMask,
  );
  state.combinedNegativeCount = countMaskPixels(state.negativeMask);
}

function renderNegativeCanvas(rebuildClosed = true, rebuildManual = true) {
  if (!state.preview || !state.negativeCenterline) return;
  if (rebuildManual) {
    state.manualNegativeMask = dilateBinaryMask(
      state.negativeCenterline,
      state.preview.width,
      state.preview.height,
      referenceJudgementRadius(),
    );
  }
  if (rebuildClosed) rebuildClosedNegativeState();
  if (rebuildClosed || rebuildManual || !state.negativeMask) rebuildCombinedNegativeMask();
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
  state.exclusionPixelCount = countMaskPixels(state.exclusionMask);
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
  const manualNegative = state.negativeCount ?? 0;
  const closedNegative = state.closedNegativeCount ?? 0;
  const borderNegative = state.borderAssistedNegativeCount ?? 0;
  const borderSeeds = state.borderAssistedSeedCount ?? 0;
  const combinedNegative = state.combinedNegativeCount ?? 0;
  const excluded = state.exclusionPixelCount ?? 0;
  const invalidFillText = state.closedNegativeInvalidCount
    ? ` / 無効seed ${state.closedNegativeInvalidCount}`
    : "";
  const verifiedRois = verifiedFullEvaluationRois().length;
  const provisionalRois = provisionalFullEvaluationRois().length;
  const roiText = provisionalRois
    ? `${verifiedRois}確認済み + ${provisionalRois}候補`
    : `${verifiedRois}領域`;
  els.annotationStatus.textContent =
    `非粒界線: ${manualNegative.toLocaleString()} px / 閉領域Fill: ${state.closedNegativeValidCount}領域 (${closedNegative.toLocaleString()} px) / 画像端Fill: ${borderSeeds}領域 (${borderNegative.toLocaleString()} px)${invalidFillText} / Negative合計: ${combinedNegative.toLocaleString()} px / 除外: ${state.exclusionRects.length}領域 (${excluded.toLocaleString()} px) / 完全評価ROI: ${roiText}`;
}


function precisionRoleLabel(role) {
  if (role === "low-recall") return "見逃しが多い領域";
  if (role === "high-leakage") return "誤検出が多い領域";
  return "平均的な領域";
}

function focusPreviewRect(rect) {
  if (!state.preview || !rect) return;
  const viewer = els.viewer.getBoundingClientRect();
  const w = Math.max(1, rect.x1 - rect.x0 + 1);
  const h = Math.max(1, rect.y1 - rect.y0 + 1);
  const margin = 56;
  state.scale = Math.max(
    0.05,
    Math.min(4, (viewer.width - margin * 2) / w, (viewer.height - margin * 2) / h),
  );
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  state.tx = viewer.width / 2 - cx * state.scale;
  state.ty = viewer.height / 2 - cy * state.scale;
  applyTransform();
}

function precisionGuideCandidates() {
  if (!state.preview || !state.analysisMask || !hasReference()) return [];
  const metrics = computeRegionalMetrics(
    state.analysisMask,
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
    {
      ...currentComparisonOptions(),
      negativeMask: state.negativeMask,
      exclusionMask: state.exclusionMask,
      cols: 4,
      rows: 4,
    },
  );
  const usable = metrics.regions.filter(region => region.referencePixels >= 40);
  if (!usable.length) return [];

  const selected = [];
  const add = (region, role) => {
    if (!region || selected.some(item => item.region.rx === region.rx && item.region.ry === region.ry)) return;
    selected.push({ region, role });
  };
  add([...usable].sort((a, b) => a.positiveRecall - b.positiveRecall)[0], "low-recall");
  add(
    [...usable]
      .filter(region => region.negativePixels > 0)
      .sort((a, b) => b.negativeLeakage - a.negativeLeakage)[0],
    "high-leakage",
  );
  add(
    [...usable].sort((a, b) => {
      const da = Math.abs(a.positiveRecall - metrics.positiveRecall)
        + Math.abs(a.negativeLeakage - metrics.negativeLeakage);
      const db = Math.abs(b.positiveRecall - metrics.positiveRecall)
        + Math.abs(b.negativeLeakage - metrics.negativeLeakage);
      return da - db;
    })[0],
    "representative",
  );
  for (const region of usable) {
    if (selected.length >= 3) break;
    add(region, "representative");
  }

  return selected.slice(0, 3).map(({ region, role }) => {
    const cellWidth = Math.max(1, region.x1 - region.x0);
    const cellHeight = Math.max(1, region.y1 - region.y0);
    const targetWidth = Math.max(120, Math.min(320, Math.round(cellWidth * 0.64)));
    const targetHeight = Math.max(90, Math.min(240, Math.round(cellHeight * 0.64)));
    const cx = (region.x0 + region.x1) / 2;
    const cy = (region.y0 + region.y1) / 2;
    const x0 = Math.max(0, Math.round(cx - targetWidth / 2));
    const y0 = Math.max(0, Math.round(cy - targetHeight / 2));
    const x1 = Math.min(state.preview.width - 1, x0 + targetWidth - 1);
    const y1 = Math.min(state.preview.height - 1, y0 + targetHeight - 1);
    return {
      x0, y0, x1, y1,
      verified: false,
      source: "precision-guide",
      guideRole: role,
      suggestedAt: new Date().toISOString(),
    };
  });
}

function activatePrecisionGuideIndex(index) {
  if (index < 0 || index >= state.fullEvaluationRois.length) return false;
  const rect = state.fullEvaluationRois[index];
  if (rect?.verified !== false) return false;
  state.precisionGuide.active = true;
  state.precisionGuide.currentRoiIndex = index;
  state.selectedFullRoiIndex = index;
  rebuildFullRoiLayer();
  setTool("reference");
  focusPreviewRect(rect);
  const pending = provisionalFullEvaluationRois().length;
  const role = precisionRoleLabel(rect.guideRole);
  els.autoOptimizeStatus.textContent =
    `精密評価ガイド: ${role}を表示中。黄破線の枠内で、見える粒界をすべて黄色のお手本線にしてから「このROIの入力完了」を押してください。残り ${pending}領域。`;
  updateControls();
  return true;
}

function startPrecisionEvaluationGuide({ autoRunAfterComplete = false, forceRegenerate = true } = {}) {
  if (!state.preview || !state.analysisMask || !hasReference()) {
    setStatus("精密評価ガイドには粒界抽出とお手本が必要です。");
    return false;
  }
  state.precisionGuide.skipForImage = false;
  if (forceRegenerate) {
    state.fullEvaluationRois = state.fullEvaluationRois.filter(
      rect => !(rect?.verified === false && rect?.source === "precision-guide"),
    );
  }
  let provisional = state.fullEvaluationRois
    .map((rect, index) => ({ rect, index }))
    .filter(item => item.rect?.verified === false);
  if (!provisional.length) {
    const suggestions = precisionGuideCandidates();
    if (!suggestions.length) {
      setStatus("精密評価ROI候補を作成できませんでした。お手本を増やしてから再実行してください。");
      return false;
    }
    for (const rect of suggestions) state.fullEvaluationRois.push(rect);
    provisional = state.fullEvaluationRois
      .map((rect, index) => ({ rect, index }))
      .filter(item => item.rect?.verified === false);
  }
  state.precisionGuide.autoRunAfterComplete = Boolean(autoRunAfterComplete);
  rebuildFullRoiLayer();
  scheduleAutosave();
  return activatePrecisionGuideIndex(provisional[0].index);
}

function finishPrecisionGuide() {
  state.precisionGuide.active = false;
  state.precisionGuide.currentRoiIndex = -1;
  state.selectedFullRoiIndex = -1;
  rebuildFullRoiLayer();
  updateMetrics(state.lastMetrics);
  updateControls();
}

function verifyCurrentPrecisionRoi() {
  if (!state.precisionGuide.active) return;
  const index = state.precisionGuide.currentRoiIndex;
  const rect = state.fullEvaluationRois[index];
  if (!rect || rect.verified !== false) return;
  rect.verified = true;
  rect.source = "precision-guide-verified";
  rect.verifiedAt = new Date().toISOString();
  rebuildFullRoiLayer();
  invalidateEvaluationOnly();
  scheduleAutosave();

  const next = state.fullEvaluationRois.findIndex(item => item?.verified === false);
  if (next >= 0) {
    activatePrecisionGuideIndex(next);
    return;
  }

  const autoRun = state.precisionGuide.autoRunAfterComplete;
  finishPrecisionGuide();
  els.autoOptimizeStatus.textContent =
    `精密評価データの準備完了: ${verifiedFullEvaluationRois().length}領域を確認済み。以後の自動最適化ではTrue F1を自動使用します。`;
  setStatus("精密評価ROIの確認が完了しました。", 100);
  if (autoRun) setTimeout(() => runOneClickOptimization({ skipPrecisionGate: true }), 0);
}

function skipPrecisionGuide() {
  if (!state.precisionGuide.active) return;
  const autoRun = state.precisionGuide.autoRunAfterComplete;
  state.fullEvaluationRois = state.fullEvaluationRois.filter(rect => rect?.verified !== false);
  state.precisionGuide.skipForImage = true;
  finishPrecisionGuide();
  scheduleAutosave();
  els.autoOptimizeStatus.textContent =
    "この画像では精密評価ROIを省略します。以後の自動最適化はPartial Label評価で実行します。";
  if (autoRun) setTimeout(() => runOneClickOptimization({ skipPrecisionGate: true }), 0);
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
  state.closedNegativeRegionIndex = null;
  state.closedNegativeDirty = state.closedNegativeSeeds.length > 0;
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
  if (!state.preview || !state.negativeCenterline || !state.manualNegativeMask || !state.negativeMask || !changedBounds) return;
  const dirty = rebuildReferenceMaskRegion(
    state.negativeCenterline,
    state.manualNegativeMask,
    state.preview.width,
    state.preview.height,
    referenceJudgementRadius(),
    changedBounds,
  );
  if (!dirty) return;
  let countDelta = 0;
  for (let y = dirty.y0; y <= dirty.y1; y += 1) {
    const base = y * state.preview.width;
    for (let x = dirty.x0; x <= dirty.x1; x += 1) {
      const p = base + x;
      const before = state.negativeMask[p] ? 1 : 0;
      const after = state.referenceMask?.[p]
        ? 0
        : (state.manualNegativeMask[p] || state.closedNegativeMask?.[p] ? 1 : 0);
      state.negativeMask[p] = after;
      countDelta += after - before;
    }
  }
  state.combinedNegativeCount = Math.max(0, (state.combinedNegativeCount ?? 0) + countDelta);
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
  const gapWasApplied = Boolean(state.gapBaseMask);
  if (gapWasApplied) {
    state.analysisMask = state.gapBaseMask;
    state.gapBaseMask = null;
    state.gapApplied = null;
  }
  invalidateTopology();
  if (gapWasApplied && els.gapStatus) {
    els.gapStatus.textContent = "Gap Bridge: 注釈変更のため適用を自動解除しました";
  }
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

function invalidateEvaluationOnly() {
  state.comparisonMode = false;
  els.referenceCanvas.style.visibility = "visible";
  els.negativeCanvas.style.visibility = "visible";
  els.exclusionCanvas.style.visibility = "visible";
  els.fullRoiCanvas.style.visibility = "visible";
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
  if (item.kind.startsWith("roi-")) invalidateEvaluationOnly();
  else invalidateAfterReferenceEdit(affectsAnalysis);

  if (item.kind === "mask-edit") {
    let referenceChanged = false;
    for (const part of item.parts) {
      applyMaskHistoryPart(part, direction);
      if (part.layer === "reference") referenceChanged = true;
    }
    if (referenceChanged) {
      renderNegativeCanvas(false, true);
      scheduleClosedFillRefresh();
    }
  } else if (item.kind === "closed-fill-add") {
    if (direction === "undo") state.closedNegativeSeeds.splice(item.index, 1);
    else state.closedNegativeSeeds.splice(item.index, 0, { ...item.seed });
    renderNegativeCanvas(true);
  } else if (item.kind === "negative-clear") {
    if (item.manualEntry) applyMaskHistoryPart({ layer: "negative", entry: item.manualEntry }, direction);
    state.closedNegativeSeeds = direction === "undo"
      ? item.closedNegativeSeeds.map(seed => ({ ...seed }))
      : [];
    renderNegativeCanvas(true);
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
  updateMetrics();
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
  resetGapBridgeState(true);
  invalidateTopology();
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
  state.closedNegativeRegionIndex = null;
  els.referenceCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  renderNegativeCanvas(true);
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

  const manualEntry = buildClearReferenceEntry(
    state.negativeCenterline,
    state.preview.width,
    state.preview.height,
  );
  const closedNegativeSeeds = state.closedNegativeSeeds.map(seed => ({ ...seed }));
  if (!manualEntry && !closedNegativeSeeds.length) return;

  state.negativeCenterline.fill(0);
  state.closedNegativeSeeds = [];
  renderNegativeCanvas(true);
  commitReferenceHistory({
    kind: "negative-clear",
    manualEntry,
    closedNegativeSeeds,
  });
  recalcAnnotationCounts();
  renderNormalOverlay();
  updateControls();
  setStatus("非粒界線と閉領域Fillを全消去しました。Undoで復元できます。");
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
  if (!state.preview || !hasAnyFullEvaluationRois()) return;
  if (state.comparisonMode) showNormalView();
  const item = {
    kind: "roi-clear",
    rects: state.fullEvaluationRois.map(rect => ({ ...rect })),
  };
  state.fullEvaluationRois = [];
  state.precisionGuide = { active: false, currentRoiIndex: -1, autoRunAfterComplete: false, skipForImage: false };
  state.selectedFullRoiIndex = -1;
  rebuildFullRoiLayer();
  invalidateEvaluationOnly();
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
    manualNegativeMask: state.manualNegativeMask,
    negativeCenterline: state.negativeCenterline,
    closedNegativeSeeds: state.closedNegativeSeeds,
    exclusionRects: state.exclusionRects,
    fullEvaluationRois: state.fullEvaluationRois,
    localCalibration: state.localCalibration,
    history: state.history,
  });
}

function cancelScheduledAutosave() {
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
  if (state.autosaveIdleHandle != null) {
    if ("cancelIdleCallback" in window) window.cancelIdleCallback(state.autosaveIdleHandle);
    else clearTimeout(state.autosaveIdleHandle);
  }
  state.autosaveIdleHandle = null;
}

async function performAutosave() {
  state.autosaveIdleHandle = null;
  if (!els.autosaveEnabled.checked || !state.sourceFingerprint || !state.preview) return;
  try {
    const serializeStartedAt = nowMs();
    const project = buildProject();
    state.performance.autosaveSerializeMs = Math.max(0, nowMs() - serializeStartedAt);

    const writeStartedAt = nowMs();
    await saveAutosave(state.sourceFingerprint, project);
    state.performance.autosaveWriteMs = Math.max(0, nowMs() - writeStartedAt);
    els.projectStatus.textContent = `自動保存済み ${new Date().toLocaleTimeString("ja-JP")} / ${state.performance.autosaveSerializeMs.toFixed(0)}+${state.performance.autosaveWriteMs.toFixed(0)} ms`;
  } catch (error) {
    console.warn("autosave failed", error);
    els.projectStatus.textContent = "自動保存に失敗しました";
  }
}

function scheduleAutosave() {
  cancelScheduledAutosave();
  if (!els.autosaveEnabled.checked || !state.sourceFingerprint || !state.preview) return;
  state.autosaveTimer = setTimeout(() => {
    state.autosaveTimer = null;
    if ("requestIdleCallback" in window) {
      state.autosaveIdleHandle = window.requestIdleCallback(
        () => { performAutosave(); },
        { timeout: 1500 },
      );
    } else {
      state.autosaveIdleHandle = setTimeout(() => {
        state.autosaveIdleHandle = null;
        performAutosave();
      }, 0);
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
  state.manualNegativeMask = new Uint8Array(state.preview.width * state.preview.height);
  state.negativeCenterline = masks.negativeCenterline;
  state.closedNegativeSeeds = masks.closedNegativeSeeds ?? [];
  state.closedNegativeMask = new Uint8Array(state.preview.width * state.preview.height);
  state.borderAssistedNegativeMask = new Uint8Array(state.preview.width * state.preview.height);
  state.closedNegativeRegionIndex = null;
  state.closedNegativeCount = 0;
  state.borderAssistedNegativeCount = 0;
  state.borderAssistedSeedCount = 0;
  state.closedNegativeValidCount = 0;
  state.closedNegativeInvalidCount = 0;
  state.exclusionRects = masks.exclusionRects;
  state.fullEvaluationRois = masks.fullEvaluationRois;
  state.precisionGuide = { active: false, currentRoiIndex: -1, autoRunAfterComplete: false, skipForImage: false };
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
  resetGapBridgeState(true);
  state.analysisMask = null;
  invalidateTopology();
  renderNormalOverlay();
  updateMetrics();
  updateControls();
  els.projectStatus.textContent = `${source}を復元しました`;
  setStatus(`${source}を復元しました。粒界お手本 ${state.referenceCount.toLocaleString()} px / 非粒界線 ${state.negativeCount.toLocaleString()} px / 閉領域Fill ${state.closedNegativeValidCount}領域 / 除外 ${state.exclusionRects.length}領域 / 完全評価ROI ${state.fullEvaluationRois.length}領域`, 100);
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

async function exportDiagnostics(mode = "zip") {
  if (!state.preview || !state.analysisMask || !hasReference()) return;
  ensureClosedNegativeFresh();
  setBusy(true);
  try {
    const features = await ensureFeatures();
    let topology = state.lastTopology;
    if (!topology) {
      setStatus("Topology診断を更新中...", 76);
      const topologyStartedAt = nowMs();
      topology = computeBoundaryTopology(
        state.analysisMask,
        state.preview.width,
        state.preview.height,
        state.closedNegativeSeeds,
        topologyOptions(),
      );
      recordPerformance("topologyMs", topologyStartedAt);
      state.lastTopology = topology;
      updateTopologyStatus(topology);
    }
    const source = {
      name: state.file?.name ?? "",
      size: state.file?.size ?? 0,
      width: state.header?.width ?? 0,
      height: state.header?.height ?? 0,
      bitDepth: state.header?.bitDepth ?? 0,
      fingerprint: state.sourceFingerprint,
    };
    const settings = currentSettings();
    const negativeHoldout = buildNegativeHoldout();
    const report = buildDiagnosticReport({
      source,
      preview: state.preview,
      settings,
      features,
      prediction: state.analysisMask,
      referenceCenterline: state.referenceCenterline,
      negativeMask: state.negativeMask,
      negativeCenterline: state.negativeCenterline,
      closedNegativeMask: state.closedNegativeMask,
      borderAssistedNegativeMask: state.borderAssistedNegativeMask,
      closedNegativeSeeds: state.closedNegativeSeeds,
      negativeHoldout,
      exclusionMask: state.exclusionMask,
      exclusionRects: state.exclusionRects,
      fullEvaluationRois: state.fullEvaluationRois,
      localCalibration: state.localCalibration,
      history: state.history,
      performance: performanceSnapshot(),
      topology,
      gapBridge: state.gapApplied,
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

    setStatus("診断データを作成中...", 82);
    const artifacts = [
      {
        name: "diagnostic.json",
        individualName: `${base}.graintracer-diagnostic.json`,
        blob: new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
      },
      {
        name: "preview.jpg",
        individualName: `${base}.graintracer-preview.jpg`,
        blob: await imageDataToBlob(state.preview.imageData, "image/jpeg", 0.90),
      },
      {
        name: "comparison.png",
        individualName: `${base}.graintracer-comparison.png`,
        blob: await imageDataToBlob(comparison.imageData, "image/png"),
      },
      {
        name: "ridge.png",
        individualName: `${base}.graintracer-ridge.png`,
        blob: await imageDataToBlob(ridgeImage, "image/png"),
      },
      {
        name: "dendrite.png",
        individualName: `${base}.graintracer-dendrite.png`,
        blob: await imageDataToBlob(dendriteImage, "image/png"),
      },
      {
        name: "reference.png",
        individualName: `${base}.graintracer-reference.png`,
        blob: await imageDataToBlob(referenceImage, "image/png"),
      },
      {
        name: "non-boundary.png",
        individualName: `${base}.graintracer-non-boundary.png`,
        blob: await imageDataToBlob(negativeImage, "image/png"),
      },
      {
        name: "exclusion.png",
        individualName: `${base}.graintracer-exclusion.png`,
        blob: await imageDataToBlob(exclusionImage, "image/png"),
      },
      {
        name: "full-roi.png",
        individualName: `${base}.graintracer-full-roi.png`,
        blob: await imageDataToBlob(fullRoiImage, "image/png"),
      },
    ];

    if (mode === "individual") {
      setStatus("診断ファイルを個別に書き出し中...", 90);
      for (const artifact of artifacts) {
        downloadBlob(artifact.blob, artifact.individualName);
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    } else {
      setStatus("診断ZIPを作成中...", 90);
      const generatedAt = new Date().toISOString();
      const manifest = {
        schema: "graintracer-diagnostic-bundle-v1",
        generatedAt,
        appVersion: APP_VERSION,
        algorithmVersion: ALGORITHM_VERSION,
        diagnosticSchema: report.schema,
        sourceName: source.name,
        sourceFingerprint: source.fingerprint,
        compression: "store",
        files: artifacts.map(artifact => ({
          name: artifact.name,
          type: artifact.blob.type || "application/octet-stream",
          size: artifact.blob.size,
        })),
      };
      const zipBlob = await buildStoredZip([
        {
          name: "manifest.json",
          data: JSON.stringify(manifest, null, 2),
          modifiedAt: new Date(generatedAt),
        },
        ...artifacts.map(artifact => ({
          name: artifact.name,
          data: artifact.blob,
          modifiedAt: new Date(generatedAt),
        })),
      ], { modifiedAt: new Date(generatedAt) });
      downloadBlob(zipBlob, `${base}.graintracer-diagnostics.zip`);
    }

    const roiText = report.evaluation.fullEvaluationRoi?.roiCount
      ? ` / ROI True F1 ${(report.evaluation.fullEvaluationRoi.f1 * 100).toFixed(1)}%`
      : "";
    const outputText = mode === "individual" ? "診断個別出力完了" : "診断ZIP出力完了";
    setStatus(
      `${outputText}: Positive Recall ${(report.evaluation.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(report.evaluation.negativeLeakage * 100).toFixed(1)}%${roiText}`,
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
  cancelScheduledClosedFillRefresh();
  cancelScheduledAutosave();
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
  state.manualNegativeMask = null;
  state.negativeCenterline = null;
  state.closedNegativeMask = null;
  state.borderAssistedNegativeMask = null;
  state.closedNegativeRegionIndex = null;
  state.closedNegativeSeeds = [];
  state.closedNegativeCount = 0;
  state.borderAssistedNegativeCount = 0;
  state.borderAssistedSeedCount = 0;
  state.closedNegativeValidCount = 0;
  state.closedNegativeInvalidCount = 0;
  state.closedNegativeDirty = false;
  state.combinedNegativeCount = 0;
  state.exclusionRects = [];
  state.exclusionMask = null;
  state.exclusionPixelCount = 0;
  state.fullEvaluationRois = [];
  state.precisionGuide = { active: false, currentRoiIndex: -1, autoRunAfterComplete: false, skipForImage: false };
  state.selectedExclusionIndex = -1;
  state.selectedFullRoiIndex = -1;
  state.rectInteraction = null;
  resetReferenceHistory();
  state.sourceFingerprint = null;
  state.localCalibration = null;
  updateLocalCalibrationStatus();
  state.history = [];
  for (const key of Object.keys(state.performance)) state.performance[key] = null;
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
    state.manualNegativeMask = new Uint8Array(preview.width * preview.height);
    state.negativeCenterline = new Uint8Array(preview.width * preview.height);
    state.closedNegativeMask = new Uint8Array(preview.width * preview.height);
    state.borderAssistedNegativeMask = new Uint8Array(preview.width * preview.height);
    state.closedNegativeRegionIndex = null;
    state.closedNegativeSeeds = [];
    state.closedNegativeCount = 0;
    state.borderAssistedNegativeCount = 0;
    state.borderAssistedSeedCount = 0;
    state.closedNegativeValidCount = 0;
    state.closedNegativeInvalidCount = 0;
    state.closedNegativeDirty = false;
    state.combinedNegativeCount = 0;
    state.exclusionMask = new Uint8Array(preview.width * preview.height);
    state.exclusionPixelCount = 0;
    state.exclusionRects = [];
    state.fullEvaluationRois = [];
    state.precisionGuide = { active: false, currentRoiIndex: -1, autoRunAfterComplete: false, skipForImage: false };
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
    state.manualNegativeMask = null;
    state.negativeCenterline = null;
    state.closedNegativeMask = null;
    state.borderAssistedNegativeMask = null;
    state.closedNegativeRegionIndex = null;
    state.closedNegativeSeeds = [];
    state.closedNegativeCount = 0;
    state.borderAssistedNegativeCount = 0;
    state.borderAssistedSeedCount = 0;
    state.closedNegativeValidCount = 0;
    state.closedNegativeInvalidCount = 0;
    state.closedNegativeDirty = false;
    state.combinedNegativeCount = 0;
    state.exclusionMask = null;
    state.exclusionPixelCount = 0;
    state.exclusionRects = [];
    state.fullEvaluationRois = [];
    state.precisionGuide = { active: false, currentRoiIndex: -1, autoRunAfterComplete: false, skipForImage: false };
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
  const startedAt = nowMs();
  setStatus(`特徴量を計算中... Dark Ridge + 色差 + デンドライト + ${options.localEnabled ? "局所適応" : "全体基準"}`, 1);
  state.features = await computeBoundaryFeatures(state.preview.imageData, {
    ...options,
    onProgress: ratio => setStatus(`特徴量を計算中... ${Math.round(ratio * 100)}%`, ratio * 70),
  });
  state.featuresKey = key;
  recordPerformance("featureComputeMs", startedAt);
  return state.features;
}

async function analyzePreview({ manageBusy = true } = {}) {
  if (!state.preview) return null;
  if (manageBusy) setBusy(true);
  try {
    const features = await ensureFeatures();
    setStatus("粒界候補を解析中...", 72);
    const analysisStartedAt = nowMs();
    resetGapBridgeState(true);
    state.analysisMask = await buildBoundaryMask(features, {
      ...currentBoundaryOptions(),
      onProgress: ratio => setStatus(`粒界候補を解析中... ${Math.round(ratio * 100)}%`, 72 + ratio * 27),
    });
    recordPerformance("boundaryAnalysisMs", analysisStartedAt);
    invalidateTopology();
    renderNormalOverlay();
    updateMetrics();
    const count = state.analysisMask.reduce((sum, value) => sum + value, 0);
    setStatus(`粒界候補を表示しました。候補画素: ${count.toLocaleString()} / 解析 ${state.performance.boundaryAnalysisMs.toFixed(0)} ms`, 100);
    return state.analysisMask;
  } catch (error) {
    console.error(error);
    setStatus(`解析エラー: ${error.message}`, 0);
    return null;
  } finally {
    if (manageBusy) setBusy(false);
  }
}

function compareCurrent(record = true) {
  if (!state.preview || !state.analysisMask || !hasReference()) return null;
  ensureClosedNegativeFresh();
  const comparisonStartedAt = nowMs();
  const result = renderComparisonOverlay(
    state.analysisMask,
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
    currentEvaluationOptions(),
  );
  els.overlayCanvas.getContext("2d").putImageData(result.imageData, 0, 0);
  applyAnnotationAssistView();
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
  recordPerformance("comparisonMs", comparisonStartedAt);
  setStatus(`比較完了: Positive Recall ${(result.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(result.metrics.negativeLeakage * 100).toFixed(1)}% / Macro Leakage ${((result.metrics.macroNegativeLeakage ?? result.metrics.negativeLeakage) * 100).toFixed(1)}%${toleranceText} / 比較 ${state.performance.comparisonMs.toFixed(0)} ms`, 100);
  return result;
}

async function autoTune({ manageBusy = true, recordHistory = true } = {}) {
  if (!state.preview || !hasReference()) return null;
  ensureClosedNegativeFresh();
  if (manageBusy) setBusy(true);
  try {
    const features = await ensureFeatures();
    const useCompleteRoi = hasFullEvaluationRois();
    const split = splitReferenceCenterline(
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      { validationFraction: 0.20, minComponentPixels: 8, strategy: "spatial-balanced", cols: 4, rows: 4 },
    );
    const negativeHoldout = buildNegativeHoldout();
    const tuningReference = useCompleteRoi
      ? state.referenceCenterline
      : split.validationPixels >= 40
        ? split.tuneMask
        : state.referenceCenterline;
    const tuningNegative = useCompleteRoi
      ? state.negativeMask
      : negativeHoldout.tuningMask;
    const objectiveText = useCompleteRoi
      ? "完全評価ROIのTrue F1"
      : "Positive Recall / Macro Negative Leakage";
    setStatus(`Auto Tune v2: ${objectiveText}を基準にCoordinate Descentで調整中...`, 1);
    const autoTuneStartedAt = nowMs();
    const result = await autoTuneBoundary(features, tuningReference, {
      ...currentComparisonOptions(),
      negativeMask: tuningNegative,
      exclusionMask: state.exclusionMask,
      fullEvaluationRois: useCompleteRoi ? verifiedFullEvaluationRois() : null,
      current: currentExtractionOptions(),
      topologyDiagnostics: {
        seeds: state.closedNegativeSeeds,
        options: closureDiagnosticOptions(),
      },
      onProgress: ratio => setStatus(`Auto Tune v2実行中... ${Math.round(ratio * 100)}%`, ratio * 99),
    });
    recordPerformance("autoTuneMs", autoTuneStartedAt);
    setRangeValue(els.sensitivity, result.parameters.sensitivity);
    setRangeValue(els.darkWeight, result.parameters.darkWeight);
    setRangeValue(els.ridgeWeight, result.parameters.ridgeWeight);
    setRangeValue(els.colorWeight, result.parameters.colorWeight);
    setRangeValue(els.dendriteWeight, result.parameters.dendriteWeight ?? Number(els.dendriteWeight.value));
    setRangeValue(els.minComponent, result.parameters.minComponent);
    state.localCalibration = null;
    updateLocalCalibrationStatus();
    resetGapBridgeState(true);
    state.analysisMask = result.mask;
    invalidateTopology();

    const comparison = renderComparisonOverlay(
      result.mask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentEvaluationOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    applyAnnotationAssistView();
    els.referenceCanvas.style.visibility = "hidden";
    els.negativeCanvas.style.visibility = "hidden";
    state.comparisonMode = true;
    updateMetrics(comparison.metrics);
    const validationMetrics = !useCompleteRoi && split.validationPixels >= 40
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
    const roiMetrics = useCompleteRoi
      ? computeFullEvaluationRoiMetrics(
        result.mask,
        state.referenceCenterline,
        state.preview.width,
        state.preview.height,
        verifiedFullEvaluationRois(),
        {
          tolerance: currentComparisonOptions().tolerance,
          exclusionMask: state.exclusionMask,
        },
      )
      : null;

    let note;
    let objectiveStatus;
    if (roiMetrics?.roiCount) {
      note = `auto-tune-v2 coordinate-descent; objective=complete-roi-f1; roiF1=${roiMetrics.f1.toFixed(4)}`;
      objectiveStatus = `ROI True F1 ${(roiMetrics.f1 * 100).toFixed(1)}% / P ${(roiMetrics.precision * 100).toFixed(1)}% / R ${(roiMetrics.recall * 100).toFixed(1)}%`;
    } else if (validationMetrics) {
      const negativeHoldoutNote = negativeHoldout.validationMask
        ? `, holdoutMacroNegativeLeakage=${(validationMetrics.macroNegativeLeakage ?? validationMetrics.negativeLeakage).toFixed(4)}`
        : ", negativeHoldout=omitted";
      note = `auto-tune-v2 coordinate-descent; objective=partial-label-region-balanced; holdout positiveRecall=${validationMetrics.positiveRecall.toFixed(4)}${negativeHoldoutNote}`;
      const holdoutLeakText = negativeHoldout.validationMask
        ? ` / 検証Macro Leak ${((validationMetrics.macroNegativeLeakage ?? validationMetrics.negativeLeakage) * 100).toFixed(1)}%`
        : "";
      objectiveStatus = `Positive Recall ${(comparison.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(comparison.metrics.negativeLeakage * 100).toFixed(1)}% / Macro Leakage ${((comparison.metrics.macroNegativeLeakage ?? comparison.metrics.negativeLeakage) * 100).toFixed(1)}% / 検証Recall ${(validationMetrics.positiveRecall * 100).toFixed(1)}%${holdoutLeakText}`;
    } else {
      note = "auto-tune-v2 coordinate-descent; objective=partial-label-region-balanced; validation holdout unavailable";
      objectiveStatus = `Positive Recall ${(comparison.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(comparison.metrics.negativeLeakage * 100).toFixed(1)}% / Macro Leakage ${((comparison.metrics.macroNegativeLeakage ?? comparison.metrics.negativeLeakage) * 100).toFixed(1)}%`;
    }

    const topologyStatus = result.topologyDiagnostics?.after?.regionCount
      ? ` / Closure ${topologyRateText(result.topologyDiagnostics.before?.closureRate)}→${topologyRateText(result.topologyDiagnostics.after?.closureRate)} (閉領域 ${result.topologyDiagnostics.before?.closedRegions ?? 0}→${result.topologyDiagnostics.after?.closedRegions ?? 0})`
      : "";
    if (recordHistory) addHistory("auto-tune", comparison.metrics, note, compactAutoTuneSearch(result.search));
    setStatus(
      `Auto Tune v2完了: ${objectiveStatus}${topologyStatus} / 感度 ${result.parameters.sensitivity} / Dark ${result.parameters.darkWeight} / Ridge ${result.parameters.ridgeWeight} / Color ${result.parameters.colorWeight} / Dendrite ${result.parameters.dendriteWeight ?? 0} / Min ${result.parameters.minComponent} / ${(state.performance.autoTuneMs / 1000).toFixed(1)} s`,
      100,
    );
    return { result, comparison, validationMetrics, roiMetrics, objectiveStatus };
  } catch (error) {
    console.error(error);
    setStatus(`自動調整エラー: ${error.message}`, 0);
    return null;
  } finally {
    if (manageBusy) setBusy(false);
  }
}

async function localTune({ manageBusy = true, recordHistory = true, scheduleSave = true } = {}) {
  if (!state.preview || !hasReference()) return null;
  ensureClosedNegativeFresh();
  if (manageBusy) setBusy(true);
  try {
    const features = await ensureFeatures();
    const extraction = currentExtractionOptions();
    const split = splitReferenceCenterline(
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      { validationFraction: 0.20, minComponentPixels: 8, strategy: "spatial-balanced", cols: 4, rows: 4 },
    );
    const tuningReference = split.validationPixels >= 40 ? split.tuneMask : state.referenceCenterline;
    const negativeHoldout = buildNegativeHoldout();
    setStatus("調整用お手本＋非粒界例を使って範囲ごとの感度を調整中...", 1);
    const calibration = await tuneLocalSensitivity(features, tuningReference, {
      ...currentComparisonOptions(),
      completeReferenceCenterline: state.referenceCenterline,
      verifiedFullEvaluationRois: verifiedFullEvaluationRois(),
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

    resetGapBridgeState(true);
    state.analysisMask = await buildBoundaryMask(features, {
      ...extraction,
      localCalibration: calibration,
      exclusionMask: state.exclusionMask,
      onProgress: ratio => setStatus(`局所補正で再抽出中... ${Math.round(ratio * 100)}%`, 62 + ratio * 36),
    });
    invalidateTopology();

    const comparison = renderComparisonOverlay(
      state.analysisMask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentEvaluationOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    applyAnnotationAssistView();
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
    if (recordHistory) addHistory(
      "local-tune",
      comparison.metrics,
      validationMetrics
        ? `4x4 partial-label calibration; holdout positiveRecall=${validationMetrics.positiveRecall.toFixed(4)}, negativeLeakage=${validationMetrics.negativeLeakage.toFixed(4)}`
        : "4x4 partial-label calibration; validation holdout unavailable",
    );
    const measured = calibration.measured.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    const roiNote = calibration.verifiedRoiCount
      ? ` / 精密評価ROI ${calibration.verifiedRoiCount}領域併用`
      : "";
    const validationNote = validationMetrics
      ? ` / 検証 Positive Recall ${(validationMetrics.positiveRecall * 100).toFixed(1)}%${negativeHoldout.validationMask ? ` / Macro Leak ${((validationMetrics.macroNegativeLeakage ?? validationMetrics.negativeLeakage) * 100).toFixed(1)}%` : ""}`
      : "";
    setStatus(
      `局所調整完了: Positive Recall ${(comparison.metrics.positiveRecall * 100).toFixed(1)}% / Negative Leakage ${(comparison.metrics.negativeLeakage * 100).toFixed(1)}%${roiNote}${validationNote} / お手本校正 ${measured}/${calibration.cols * calibration.rows}領域`,
      100,
    );
    if (scheduleSave) scheduleAutosave();
    return { calibration, comparison, validationMetrics };
  } catch (error) {
    console.error(error);
    setStatus(`局所調整エラー: ${error.message}`, 0);
    return null;
  } finally {
    if (manageBusy) setBusy(false);
  }
}


function cloneOptimizationValue(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  if (ArrayBuffer.isView(value)) return value.slice();
  return JSON.parse(JSON.stringify(value));
}

function evaluateOptimizationMask(mask = state.analysisMask) {
  if (!state.preview || !mask || !hasReference()) return null;
  ensureClosedNegativeFresh();
  const metrics = computeRegionalMetrics(
    mask,
    state.referenceCenterline,
    state.preview.width,
    state.preview.height,
    {
      ...currentComparisonOptions(),
      negativeMask: state.negativeMask,
      exclusionMask: state.exclusionMask,
      cols: 4,
      rows: 4,
    },
  );
  const verifiedRois = verifiedFullEvaluationRois();
  const roiMetrics = verifiedRois.length
    ? computeFullEvaluationRoiMetrics(
      mask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      verifiedRois,
      {
        tolerance: currentComparisonOptions().tolerance,
        exclusionMask: state.exclusionMask,
      },
    )
    : null;
  const closureProfile = computeClosureProfile(
    mask,
    state.preview.width,
    state.preview.height,
    state.closedNegativeSeeds,
    {
      ...closureDiagnosticOptions(),
      bridgeRadii: [0, 1, 2, 3],
    },
  );
  return { metrics, roiMetrics, closureProfile };
}

function optimizationPrimaryScore(evaluation) {
  if (!evaluation) return -Infinity;
  if (evaluation.roiMetrics?.roiCount) return evaluation.roiMetrics.f1;
  const recall = evaluation.metrics?.positiveRecall ?? 0;
  const leak = evaluation.metrics?.macroNegativeLeakage
    ?? evaluation.metrics?.negativeLeakage
    ?? 0;
  return recall * 0.72 + (1 - leak) * 0.28;
}

function compactOptimizationEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    objective: evaluation.roiMetrics?.roiCount ? "complete-roi-f1" : "partial-label-balanced",
    score: optimizationPrimaryScore(evaluation),
    positiveRecall: evaluation.metrics?.positiveRecall ?? null,
    negativeLeakage: evaluation.metrics?.negativeLeakage ?? null,
    macroNegativeLeakage: evaluation.metrics?.macroNegativeLeakage ?? null,
    roiF1: evaluation.roiMetrics?.roiCount ? evaluation.roiMetrics.f1 : null,
    roiPrecision: evaluation.roiMetrics?.roiCount ? evaluation.roiMetrics.precision : null,
    roiRecall: evaluation.roiMetrics?.roiCount ? evaluation.roiMetrics.recall : null,
    topology: evaluation.closureProfile ? {
      weightedClosureScore: evaluation.closureProfile.weightedClosureScore,
      meanRequiredRadiusCapped: evaluation.closureProfile.meanRequiredRadiusCapped,
      minimumRadiusHistogram: evaluation.closureProfile.minimumRadiusHistogram,
      openAfterMaxRadius: evaluation.closureProfile.openAfterMaxRadius,
      regionCount: evaluation.closureProfile.regionCount,
    } : null,
  };
}

function captureOptimizationState(evaluation = null) {
  if (!state.analysisMask) return null;
  return {
    parameters: { ...currentExtractionOptions() },
    localCalibration: cloneOptimizationValue(state.localCalibration),
    mask: state.analysisMask.slice(),
    evaluation: evaluation ?? evaluateOptimizationMask(state.analysisMask),
  };
}

function restoreOptimizationState(snapshot) {
  if (!snapshot?.mask) return;
  setRangeValue(els.sensitivity, snapshot.parameters.sensitivity);
  setRangeValue(els.darkWeight, snapshot.parameters.darkWeight);
  setRangeValue(els.ridgeWeight, snapshot.parameters.ridgeWeight);
  setRangeValue(els.colorWeight, snapshot.parameters.colorWeight);
  setRangeValue(els.dendriteWeight, snapshot.parameters.dendriteWeight);
  setRangeValue(els.minComponent, snapshot.parameters.minComponent);
  els.centerlineNms.checked = snapshot.parameters.centerlineNms !== false;
  state.localCalibration = cloneOptimizationValue(snapshot.localCalibration);
  updateLocalCalibrationStatus();
  resetGapBridgeState(true);
  state.analysisMask = snapshot.mask.slice();
  invalidateTopology();
  renderNormalOverlay();
  updateMetrics();
}

function tuningStageGuardDecision(before, after) {
  if (!before || !after) return { passed: false, reason: "missing-evaluation" };
  const beforeRecall = before.metrics?.positiveRecall ?? 0;
  const afterRecall = after.metrics?.positiveRecall ?? 0;
  const beforeLeak = before.metrics?.macroNegativeLeakage ?? before.metrics?.negativeLeakage ?? 0;
  const afterLeak = after.metrics?.macroNegativeLeakage ?? after.metrics?.negativeLeakage ?? 0;
  if (afterRecall < beforeRecall - 0.005) {
    return { passed: false, reason: "positive-recall-regression" };
  }
  if (afterLeak > beforeLeak + 0.005) {
    return { passed: false, reason: "macro-negative-leakage-regression" };
  }
  if (before.roiMetrics?.roiCount && after.roiMetrics?.roiCount
      && after.roiMetrics.f1 < before.roiMetrics.f1 - 0.002) {
    return { passed: false, reason: "verified-roi-f1-regression" };
  }
  if (before.closureProfile?.regionCount && after.closureProfile?.regionCount) {
    const topologyDrop =
      (before.closureProfile.weightedClosureScore ?? 0)
      - (after.closureProfile.weightedClosureScore ?? 0);
    const openIncrease =
      (after.closureProfile.openAfterMaxRadius ?? 0)
      - (before.closureProfile.openAfterMaxRadius ?? 0);
    if (topologyDrop > 0.01) {
      return { passed: false, reason: "weighted-closure-regression" };
    }
    if (openIncrease > 3) {
      return { passed: false, reason: "open-at-3-regression" };
    }
  }
  return { passed: true, reason: null };
}

function tuningStagePassesGuard(before, after) {
  return tuningStageGuardDecision(before, after).passed;
}

function summarizeLocalCalibration(calibration) {
  if (!calibration) return null;
  const values = calibration.values ?? [];
  const measured = calibration.measured ?? [];
  const nonZeroRegions = values.reduce(
    (sum, value) => sum + (Math.abs(Number(value) || 0) > 1e-6 ? 1 : 0),
    0,
  );
  const maxAbsDelta = values.reduce(
    (maxValue, value) => Math.max(maxValue, Math.abs(Number(value) || 0)),
    0,
  );
  return {
    version: calibration.version ?? null,
    kind: calibration.kind ?? null,
    objectiveMode: calibration.objectiveMode ?? "partial-label",
    cols: calibration.cols,
    rows: calibration.rows,
    baseSensitivity: calibration.baseSensitivity,
    maxDelta: calibration.maxDelta ?? null,
    maxRegionalRecallDrop: calibration.maxRegionalRecallDrop ?? null,
    minAdjustedGain: calibration.minAdjustedGain ?? null,
    propagationRadiusCells: calibration.propagationRadiusCells ?? null,
    measuredZeroAnchors: calibration.measuredZeroAnchors ?? false,
    measuredRegions: measured.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    nonZeroRegions,
    maxAbsDelta,
    verifiedRoiCount: calibration.verifiedRoiCount ?? 0,
    verifiedRoiPixels: calibration.verifiedRoiPixels ?? 0,
    values,
    regions: (calibration.regions ?? []).map(region => ({
      rx: region.rx,
      ry: region.ry,
      measured: region.measured,
      referencePixels: region.referencePixels,
      verifiedRoiPixels: region.verifiedRoiPixels ?? 0,
      rawDelta: region.rawDelta,
      selectedSensitivity: region.selectedSensitivity ?? null,
      bestAdjustedScore: region.bestAdjustedScore ?? null,
      bestF1: region.bestF1,
      bestPrecision: region.bestPrecision,
      bestRecall: region.bestRecall,
      baselineF1: region.baselineF1 ?? null,
      baselinePrecision: region.baselinePrecision ?? null,
      baselineRecall: region.baselineRecall ?? null,
      selectionReason: region.selectionReason ?? null,
      candidateResults: region.candidateResults ?? [],
    })),
  };
}

function gapProposalPassesGuard(before, after) {
  if (!before || !after) return false;
  const beforeRecall = before.metrics?.positiveRecall ?? 0;
  const afterRecall = after.metrics?.positiveRecall ?? 0;
  const beforeLeak = before.metrics?.macroNegativeLeakage ?? before.metrics?.negativeLeakage ?? 0;
  const afterLeak = after.metrics?.macroNegativeLeakage ?? after.metrics?.negativeLeakage ?? 0;
  if (afterRecall < beforeRecall - 0.001) return false;
  if (afterLeak > beforeLeak + 0.001) return false;
  if (before.roiMetrics?.roiCount && after.roiMetrics?.roiCount) {
    if (after.roiMetrics.f1 < before.roiMetrics.f1 - 0.001) return false;
  }

  const beforeProfile = before.closureProfile;
  const afterProfile = after.closureProfile;
  if (beforeProfile?.regionCount && afterProfile?.regionCount) {
    const scoreGain =
      (afterProfile.weightedClosureScore ?? 0) - (beforeProfile.weightedClosureScore ?? 0);
    const openGain =
      (beforeProfile.openAfterMaxRadius ?? 0) - (afterProfile.openAfterMaxRadius ?? 0);
    const radiusGain =
      (beforeProfile.meanRequiredRadiusCapped ?? Infinity)
      - (afterProfile.meanRequiredRadiusCapped ?? Infinity);
    return scoreGain > 0.00025 || openGain > 0 || radiusGain > 0.002;
  }

  return optimizationPrimaryScore(after) > optimizationPrimaryScore(before) + 0.001;
}

function optimizationStatusSummary(evaluation) {
  if (!evaluation) return "-";
  const metrics = evaluation.metrics;
  const profile = evaluation.closureProfile;
  const roi = evaluation.roiMetrics;
  const base =
    `Recall ${((metrics?.positiveRecall ?? 0) * 100).toFixed(1)}% / Macro Leak ${((metrics?.macroNegativeLeakage ?? metrics?.negativeLeakage ?? 0) * 100).toFixed(1)}%`;
  const roiText = roi?.roiCount ? ` / True F1 ${(roi.f1 * 100).toFixed(1)}%` : "";
  const topologyText = profile?.regionCount
    ? ` / Topology ${((profile.weightedClosureScore ?? 0) * 100).toFixed(1)}% / Open@3 ${profile.openAfterMaxRadius}`
    : "";
  return base + roiText + topologyText;
}

async function guardedGapOptimizationPass(mode) {
  if (!state.preview || !state.analysisMask) return { accepted: false, reason: "no-analysis" };
  if (mode === "extended" && !state.features) await ensureFeatures();
  const before = evaluateOptimizationMask(state.analysisMask);
  const proposal = mode === "extended"
    ? proposeExtendedGapBridges(
      state.analysisMask,
      state.preview.width,
      state.preview.height,
      topologyOptions(),
    )
    : proposeShortGapBridges(
      state.analysisMask,
      state.preview.width,
      state.preview.height,
      topologyOptions(),
    );
  if (!proposal?.acceptedBridgeCount) {
    return { accepted: false, reason: "no-candidate", proposal, before, after: before };
  }
  const after = evaluateOptimizationMask(proposal.mask);
  const accepted = gapProposalPassesGuard(before, after);
  if (!accepted) {
    return { accepted: false, reason: "guard-rejected", proposal, before, after };
  }

  proposal.evaluation = {
    before: {
      positiveRecall: before.metrics.positiveRecall,
      negativeLeakage: before.metrics.negativeLeakage,
      macroNegativeLeakage: before.metrics.macroNegativeLeakage,
    },
    after: {
      positiveRecall: after.metrics.positiveRecall,
      negativeLeakage: after.metrics.negativeLeakage,
      macroNegativeLeakage: after.metrics.macroNegativeLeakage,
    },
  };
  proposal.topology = evaluateGapTopology(proposal.mask);
  proposal.closureProfile = {
    before: compactOptimizationEvaluation(before)?.topology ?? null,
    after: compactOptimizationEvaluation(after)?.topology ?? null,
  };
  state.gapProposal = proposal;
  await applyGapBridges();
  return { accepted: true, proposal, before, after };
}

async function runOneClickOptimization({ skipPrecisionGate = false } = {}) {
  if (!state.preview || !hasReference()) return null;
  if (state.precisionGuide.active && !skipPrecisionGate) {
    setStatus("精密評価ガイドを完了するか「精密評価は後で」を選んでください。");
    return { waitingForPrecisionGuide: true };
  }

  if (!state.analysisMask) {
    setBusy(true);
    els.autoOptimizeStatus.textContent = "自動最適化の準備として初期粒界を抽出しています。";
    const mask = await analyzePreview({ manageBusy: false });
    setBusy(false);
    if (!mask) return null;
  }

  if (!skipPrecisionGate && !hasFullEvaluationRois() && !state.precisionGuide.skipForImage) {
    const hasPending = provisionalFullEvaluationRois().length > 0;
    const started = startPrecisionEvaluationGuide({
      autoRunAfterComplete: true,
      forceRegenerate: !hasPending,
    });
    if (started) {
      els.autoOptimizeStatus.textContent +=
        " 「精密評価は後で」を押せば、この画像では精密評価を省略してPartial Labelだけで続行できます。";
      return { waitingForPrecisionGuide: true };
    }
  }

  const startedAt = nowMs();
  setBusy(true);
  let baseline = null;
  try {
    ensureClosedNegativeFresh();
    await ensureFeatures();
    baseline = evaluateOptimizationMask(state.analysisMask);
    const baselineSnapshot = captureOptimizationState(baseline);
    els.autoOptimizeStatus.textContent =
      "自動最適化中: Global Auto Tune → Local Calibration → Topology Guarded Gap の順に評価します。";
    setStatus("自動最適化 1/4: Global Auto Tune...", 5);

    const globalRun = await autoTune({ manageBusy: false, recordHistory: false });
    if (!globalRun) throw new Error("Global Auto Tuneに失敗しました。");
    const globalEvaluation = evaluateOptimizationMask(state.analysisMask);
    const globalSnapshot = captureOptimizationState(globalEvaluation);
    const globalGuard = tuningStageGuardDecision(baseline, globalEvaluation);
    const globalPrimaryRegressed =
      optimizationPrimaryScore(globalEvaluation) < optimizationPrimaryScore(baseline) - 0.002;
    const globalStage = {
      status: "accepted",
      reason: null,
      guard: globalGuard,
      primaryScoreRegressed: globalPrimaryRegressed,
      before: compactOptimizationEvaluation(baseline),
      after: compactOptimizationEvaluation(globalEvaluation),
    };

    let selectedStage = "global";
    let selectedEvaluation = globalEvaluation;
    let selectedSnapshot = globalSnapshot;
    if (!globalGuard.passed || globalPrimaryRegressed) {
      globalStage.status = "rolled-back";
      globalStage.reason = globalGuard.reason ?? "primary-score-regression";
      restoreOptimizationState(baselineSnapshot);
      selectedStage = "baseline";
      selectedEvaluation = baseline;
      selectedSnapshot = baselineSnapshot;
    }

    setStatus("自動最適化 2/4: Local Calibration...", 42);
    const localBaseEvaluation = selectedEvaluation;
    const localRun = await localTune({
      manageBusy: false,
      recordHistory: false,
      scheduleSave: false,
    });
    if (!localRun) throw new Error("Local Calibrationに失敗しました。");
    const localEvaluation = evaluateOptimizationMask(state.analysisMask);
    const localGuard = tuningStageGuardDecision(localBaseEvaluation, localEvaluation);
    const localPrimaryRegressed =
      optimizationPrimaryScore(localEvaluation) < optimizationPrimaryScore(localBaseEvaluation) - 0.002;
    const localCalibrationSummary = summarizeLocalCalibration(localRun.calibration);
    const localNoChange = (localCalibrationSummary?.nonZeroRegions ?? 0) === 0;
    const localStage = {
      status: "accepted",
      reason: null,
      guard: localGuard,
      primaryScoreRegressed: localPrimaryRegressed,
      noChange: localNoChange,
      before: compactOptimizationEvaluation(localBaseEvaluation),
      after: compactOptimizationEvaluation(localEvaluation),
      calibration: localCalibrationSummary,
    };

    if (!localGuard.passed || localPrimaryRegressed) {
      localStage.status = "rolled-back";
      localStage.reason = localGuard.reason ?? "primary-score-regression";
      restoreOptimizationState(selectedSnapshot);
    } else if (localNoChange) {
      localStage.status = "no-change";
      localStage.reason = "no-better-local-delta";
      restoreOptimizationState(selectedSnapshot);
    } else {
      selectedStage = "local";
      selectedEvaluation = localEvaluation;
      selectedSnapshot = captureOptimizationState(localEvaluation);
    }

    setStatus("自動最適化 3/4: Topology Guarded Gap...", 72);
    const safePass = await guardedGapOptimizationPass("safe");
    const extendedPass = await guardedGapOptimizationPass("extended");

    setStatus("自動最適化 4/4: 最終検証...", 90);
    const finalEvaluation = evaluateOptimizationMask(state.analysisMask);
    const topologyStartedAt = nowMs();
    state.lastTopology = computeBoundaryTopology(
      state.analysisMask,
      state.preview.width,
      state.preview.height,
      state.closedNegativeSeeds,
      topologyOptions(),
    );
    recordPerformance("topologyMs", topologyStartedAt);
    updateTopologyStatus(state.lastTopology);
    const comparison = compareCurrent(false);
    recordPerformance("autoOptimizeMs", startedAt);

    const safeCount = safePass.accepted ? safePass.proposal.acceptedBridgeCount : 0;
    const extendedCount = extendedPass.accepted ? extendedPass.proposal.acceptedBridgeCount : 0;
    const evaluationMode = finalEvaluation.roiMetrics?.roiCount
      ? `精密評価ROI ${finalEvaluation.roiMetrics.roiCount}領域`
      : "Partial Label";
    const note =
      `one-click-optimize; selected=${selectedStage}; evaluation=${evaluationMode}; global=${globalStage.status}; local=${localStage.status}; safe=${safeCount}; extended=${extendedCount}`;
    addHistory("auto-optimize", comparison?.metrics ?? finalEvaluation.metrics, note, {
      version: 2,
      baseline: compactOptimizationEvaluation(baseline),
      global: compactOptimizationEvaluation(globalEvaluation),
      local: compactOptimizationEvaluation(localEvaluation),
      final: compactOptimizationEvaluation(finalEvaluation),
      selectedStage,
      stages: {
        global: globalStage,
        local: localStage,
      },
      gap: {
        safe: {
          accepted: safePass.accepted,
          reason: safePass.reason ?? null,
          bridges: safeCount,
        },
        extended: {
          accepted: extendedPass.accepted,
          reason: extendedPass.reason ?? null,
          bridges: extendedCount,
        },
      },
    });
    scheduleAutosave();

    const beforeText = optimizationStatusSummary(baseline);
    const afterText = optimizationStatusSummary(finalEvaluation);
    els.autoOptimizeStatus.textContent =
      `自動最適化完了（${evaluationMode}）: ${beforeText} → ${afterText} / Gap Safe ${safeCount}本・Extended ${extendedCount}本 / ${(state.performance.autoOptimizeMs / 1000).toFixed(1)} s`;
    setStatus(els.autoOptimizeStatus.textContent, 100);
    return { baseline, finalEvaluation, safePass, extendedPass, selectedStage };
  } catch (error) {
    console.error(error);
    els.autoOptimizeStatus.textContent = `自動最適化エラー: ${error.message}`;
    setStatus(els.autoOptimizeStatus.textContent, 0);
    return null;
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
  els.closedNegativeFillToolButton.classList.toggle("active", tool === "closed-negative-fill");
  els.eraseReferenceToolButton.classList.toggle("active", tool === "erase-reference");
  els.exclusionToolButton.classList.toggle("active", tool === "exclusion");
  els.fullRoiToolButton.classList.toggle("active", tool === "full-roi");
  els.viewer.classList.toggle("reference-mode", tool !== "pan");
  if (state.preview) {
    renderExclusionCanvas(
      els.exclusionCanvas,
      state.exclusionRects,
      state.preview.width,
      state.preview.height,
      null,
      tool === "exclusion" ? state.selectedExclusionIndex : -1,
      annotationHandleSize(),
    );
    renderFullEvaluationRoiCanvas(
      els.fullRoiCanvas,
      state.fullEvaluationRois,
      state.preview.width,
      state.preview.height,
      null,
      tool === "full-roi" ? state.selectedFullRoiIndex : -1,
      annotationHandleSize(),
    );
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

function closedFillFailureMessage(reason) {
  if (reason === "seed-on-boundary") return "黄色のお手本線上では閉領域Fillできません。粒の内側をクリックしてください。";
  if (reason === "open-region") return "閉領域ではありません。黄色線を閉じるか、画像端と黄色線で囲う場合は「画像端を閉境界として許可」を有効にしてください。";
  if (reason === "region-too-large") return "閉領域が大きすぎるため安全のためFillしませんでした。";
  if (reason === "border-region-too-large") return "画像端を使う領域が大きすぎるため安全のためFillしませんでした。黄色線を追加して領域を絞ってください。";
  if (reason === "border-too-many-sides") return "画像端への接触範囲が広すぎます。1辺または隣接する2辺と黄色線で囲った領域だけを許可します。";
  if (reason === "border-insufficient-reference") return "画像端だけで囲われており、黄色のお手本線との接触が不足しています。黄色線を追加してください。";
  if (reason === "region-too-small") return "閉領域が小さすぎるためFillしませんでした。";
  if (reason === "duplicate-region") return "この閉領域はすでに非粒界Fillされています。";
  return "この位置では閉領域Fillできませんでした。";
}

function addClosedNegativeFill(event) {
  if (!state.preview || !state.referenceMask || !hasReference()) return false;
  const annotationStartedAt = nowMs();
  const point = eventToPreviewPoint(event);
  if (!point) return false;
  const seed = {
    x: Math.round(point.x),
    y: Math.round(point.y),
    borderAssisted: Boolean(els.borderAssistedFill.checked),
  };
  const p = seed.y * state.preview.width + seed.x;

  if (state.closedNegativeSeeds.some(item => item.x === seed.x && item.y === seed.y)) {
    setStatus("この位置はすでに閉領域Fillのseedとして登録されています。");
    return false;
  }
  if (state.closedNegativeMask?.[p]) {
    setStatus("この閉領域はすでに非粒界Fillされています。");
    return false;
  }

  const candidateSeeds = [...state.closedNegativeSeeds, seed];
  const rebuilt = rebuildClosedNegativeMask(
    state.referenceMask,
    state.preview.width,
    state.preview.height,
    candidateSeeds,
    closedNegativeFillOptions(),
    state.closedNegativeRegionIndex,
  );
  const result = rebuilt.results[rebuilt.results.length - 1];
  if (!result?.accepted) {
    setStatus(closedFillFailureMessage(result?.reason));
    return false;
  }

  if (state.comparisonMode) showNormalView();
  invalidateAfterReferenceEdit();
  const index = state.closedNegativeSeeds.length;
  const acceptedSeed = { ...seed, borderAssisted: Boolean(result.usesImageBorder) };
  state.closedNegativeSeeds.push(acceptedSeed);
  state.closedNegativeRegionIndex = rebuilt.regionIndex ?? state.closedNegativeRegionIndex;
  state.closedNegativeMask = rebuilt.mask;
  state.borderAssistedNegativeMask = rebuilt.borderAssistedMask ?? new Uint8Array(state.preview.width * state.preview.height);
  state.closedNegativeCount = rebuilt.fillPixels ?? countMaskPixels(rebuilt.mask);
  state.borderAssistedNegativeCount = rebuilt.borderAssistedPixels ?? countMaskPixels(state.borderAssistedNegativeMask);
  state.borderAssistedSeedCount = rebuilt.borderAssistedCount ?? 0;
  state.closedNegativeValidCount = rebuilt.validCount;
  state.closedNegativeInvalidCount = rebuilt.invalidCount;
  state.closedNegativeDirty = false;
  state.performance.closedFillRebuildMs = rebuilt.elapsedMs ?? null;
  state.manualNegativeMask = dilateBinaryMask(
    state.negativeCenterline,
    state.preview.width,
    state.preview.height,
    referenceJudgementRadius(),
  );
  rebuildCombinedNegativeMask();
  renderBinaryMaskCanvas(
    els.negativeCanvas,
    state.negativeMask,
    state.preview.width,
    state.preview.height,
    referenceOpacityRatio(),
    [255, 138, 0],
  );
  commitReferenceHistory({ kind: "closed-fill-add", index, seed: { ...acceptedSeed } });
  recalcAnnotationCounts();
  updateMetrics();
  updateControls();
  recordPerformance("annotationCommitMs", annotationStartedAt);
  setStatus(
    `${result.usesImageBorder ? "画像端＋お手本線" : "閉領域"}を非粒界化しました: ${result.fillPixels.toLocaleString()} px / safety 3px / Fill ${state.closedNegativeValidCount}領域 / rebuild ${state.performance.closedFillRebuildMs?.toFixed(0) ?? "-"} ms / total ${state.performance.annotationCommitMs?.toFixed(0) ?? "-"} ms。Undoで取り消せます。`,
  );
  scheduleAutosave();
  return true;
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
  cancelScheduledClosedFillRefresh();
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
  const annotationCommitStartedAt = nowMs();
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
  if (referenceEntry) {
    renderNegativeCanvas(false, true);
    scheduleClosedFillRefresh();
  }

  recalcAnnotationCounts();
  updateMetrics();
  updateControls();
  recordPerformance("annotationCommitMs", annotationCommitStartedAt);
  setStatus(
    `注釈を更新しました。粒界 ${state.referenceCount.toLocaleString()} px / 非粒界 ${state.negativeCount.toLocaleString()} px / ${state.performance.annotationCommitMs?.toFixed(0) ?? "-"} ms`,
  );
  scheduleAutosave();
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}

function getRectCollection(kind) {
  return kind === "exclusion" ? state.exclusionRects : state.fullEvaluationRois;
}

function getSelectedRectIndex(kind) {
  return kind === "exclusion" ? state.selectedExclusionIndex : state.selectedFullRoiIndex;
}

function setSelectedRectIndex(kind, index) {
  if (kind === "exclusion") state.selectedExclusionIndex = index;
  else state.selectedFullRoiIndex = index;
}

function renderRectLayer(kind, previewRect = null) {
  if (!state.preview) return;
  if (kind === "exclusion") {
    renderExclusionCanvas(
      els.exclusionCanvas,
      state.exclusionRects,
      state.preview.width,
      state.preview.height,
      previewRect,
      state.tool === "exclusion" ? state.selectedExclusionIndex : -1,
      annotationHandleSize(),
    );
  } else {
    renderFullEvaluationRoiCanvas(
      els.fullRoiCanvas,
      state.fullEvaluationRois,
      state.preview.width,
      state.preview.height,
      previewRect,
      state.tool === "full-roi" ? state.selectedFullRoiIndex : -1,
      annotationHandleSize(),
    );
  }
}

function rectsEqual(a, b) {
  return a && b
    && a.x0 === b.x0 && a.y0 === b.y0
    && a.x1 === b.x1 && a.y1 === b.y1;
}

function beginRectInteraction(event, kind) {
  const point = eventToPreviewPoint(event);
  if (!point) return false;
  if (state.comparisonMode) showNormalView();

  const rects = getRectCollection(kind);
  const hit = hitTestRect(rects, point, annotationHitThreshold());
  if (hit) {
    setSelectedRectIndex(kind, hit.index);
    state.rectInteraction = {
      kind,
      action: "edit",
      index: hit.index,
      mode: hit.mode,
      start: point,
      before: { ...rects[hit.index] },
    };
    renderRectLayer(kind);
  } else {
    setSelectedRectIndex(kind, -1);
    const previewRect = normalizeRect(point, point, state.preview.width, state.preview.height);
    state.rectInteraction = {
      kind,
      action: "new",
      start: point,
      previewRect,
    };
    renderRectLayer(kind, previewRect);
  }

  els.viewer.setPointerCapture(event.pointerId);
  return true;
}

function continueRectInteraction(event) {
  const interaction = state.rectInteraction;
  if (!interaction) return;
  const point = eventToPreviewPoint(event);
  if (!point) return;

  if (interaction.action === "new") {
    interaction.previewRect = normalizeRect(
      interaction.start,
      point,
      state.preview.width,
      state.preview.height,
    );
    renderRectLayer(interaction.kind, interaction.previewRect);
    return;
  }

  const rects = getRectCollection(interaction.kind);
  rects[interaction.index] = {
    ...interaction.before,
    ...transformRect(
      interaction.before,
      interaction.start,
      point,
      interaction.mode,
      state.preview.width,
      state.preview.height,
    ),
  };
  renderRectLayer(interaction.kind);
}

function endRectInteraction(event) {
  const interaction = state.rectInteraction;
  if (!interaction) return;
  state.rectInteraction = null;

  const rects = getRectCollection(interaction.kind);
  const isExclusion = interaction.kind === "exclusion";
  const historyPrefix = isExclusion ? "exclusion" : "roi";
  let changed = false;

  if (interaction.action === "new") {
    const rect = interaction.previewRect;
    if (rect && rectArea(rect) >= 9) {
      const index = rects.length;
      const storedRect = isExclusion
        ? { ...rect }
        : { ...rect, verified: true, source: "manual" };
      rects.push(storedRect);
      setSelectedRectIndex(interaction.kind, index);
      commitReferenceHistory({ kind: historyPrefix + "-add", index, rect: { ...storedRect } });
      changed = true;
    }
  } else {
    const after = rects[interaction.index];
    if (after && !rectsEqual(interaction.before, after)) {
      commitReferenceHistory({
        kind: historyPrefix + "-edit",
        index: interaction.index,
        before: { ...interaction.before },
        after: { ...after },
      });
      changed = true;
    }
  }

  renderRectLayer(interaction.kind);

  if (changed) {
    if (isExclusion) invalidateAfterReferenceEdit(true);
    else invalidateEvaluationOnly();
    if (isExclusion) {
      rebuildExclusionLayer();
      setStatus("除外領域を更新しました。除外 " + state.exclusionRects.length + "領域。再解析してください。");
    } else {
      rebuildFullRoiLayer();
      setStatus("完全評価ROIを更新しました。ROI " + state.fullEvaluationRois.length + "領域。比較を実行してください。");
    }
    scheduleAutosave();
  }

  updateControls();
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}

function deleteSelectedRect(kind) {
  if (!state.preview) return false;
  const rects = getRectCollection(kind);
  const index = getSelectedRectIndex(kind);
  if (index < 0 || index >= rects.length) return false;
  if (state.comparisonMode) showNormalView();

  const [rect] = rects.splice(index, 1);
  setSelectedRectIndex(kind, -1);
  const isExclusion = kind === "exclusion";
  commitReferenceHistory({
    kind: (isExclusion ? "exclusion" : "roi") + "-delete",
    index,
    rect: { ...rect },
  });
  renderRectLayer(kind);
  if (isExclusion) invalidateAfterReferenceEdit(true);
  else invalidateEvaluationOnly();
  if (isExclusion) {
    rebuildExclusionLayer();
    setStatus("選択した除外矩形を削除しました。再解析してください。Undoで復元できます。");
  } else {
    rebuildFullRoiLayer();
    setStatus("選択した完全評価ROIを削除しました。Undoで復元できます。");
  }
  scheduleAutosave();
  updateControls();
  return true;
}

els.fileInput.addEventListener("change", event => loadBmp(event.target.files?.[0]));
els.projectInput.addEventListener("change", event => importProjectFile(event.target.files?.[0]));
els.fitButton.addEventListener("click", fitToViewer);
els.actualButton.addEventListener("click", actualSize);
els.clearOverlayButton.addEventListener("click", clearOverlay);
els.annotationAssistButton.addEventListener("click", () => toggleAnnotationAssist());
els.analyzeButton.addEventListener("click", analyzePreview);
els.compareButton.addEventListener("click", () => compareCurrent(true));
els.autoOptimizeButton.addEventListener("click", () => runOneClickOptimization());
els.precisionGuideButton.addEventListener("click", () => startPrecisionEvaluationGuide({ autoRunAfterComplete: false, forceRegenerate: true }));
els.precisionVerifyButton.addEventListener("click", verifyCurrentPrecisionRoi);
els.precisionSkipButton.addEventListener("click", skipPrecisionGuide);
els.autoTuneButton.addEventListener("click", () => autoTune());
els.localTuneButton.addEventListener("click", () => localTune());
els.clearLocalCalibrationButton.addEventListener("click", () => clearLocalCalibration(false));
els.clearReferenceButton.addEventListener("click", clearReference);
els.clearNegativeButton.addEventListener("click", clearNegativeReference);
els.clearExclusionButton.addEventListener("click", clearExclusions);
els.clearFullRoiButton.addEventListener("click", clearFullEvaluationRois);
els.showNormalButton.addEventListener("click", showNormalView);
els.topologyButton.addEventListener("click", runTopologyDiagnostics);
els.gapPreviewButton.addEventListener("click", previewSafeGapBridges);
els.extendedGapPreviewButton.addEventListener("click", previewExtendedGapBridges);
els.gapApplyButton.addEventListener("click", applyGapBridges);
els.gapRevertButton.addEventListener("click", revertGapBridges);
els.saveProjectButton.addEventListener("click", saveProjectManual);
els.loadProjectButton.addEventListener("click", () => els.projectInput.click());
els.exportDiagnosticsButton.addEventListener("click", () => exportDiagnostics("zip"));
els.exportDiagnosticsIndividualButton.addEventListener("click", () => exportDiagnostics("individual"));
els.panToolButton.addEventListener("click", () => setTool("pan"));
els.referenceToolButton.addEventListener("click", () => setTool("reference"));
els.negativeToolButton.addEventListener("click", () => setTool("negative-reference"));
els.closedNegativeFillToolButton.addEventListener("click", () => setTool("closed-negative-fill"));
els.eraseReferenceToolButton.addEventListener("click", () => setTool("erase-reference"));
els.exclusionToolButton.addEventListener("click", () => setTool("exclusion"));
els.fullRoiToolButton.addEventListener("click", () => setTool("full-roi"));
els.undoReferenceButton.addEventListener("click", undoReference);
els.redoReferenceButton.addEventListener("click", redoReference);

bindRange(els.sensitivity, $("sensitivityValue"), extractionSettingChanged);
bindRange(els.darkWeight, $("darkWeightValue"), extractionSettingChanged);
bindRange(els.ridgeWeight, $("ridgeWeightValue"), extractionSettingChanged);
bindRange(els.colorWeight, $("colorWeightValue"), extractionSettingChanged);
bindRange(els.dendriteWeight, $("dendriteWeightValue"), extractionSettingChanged);
bindRange(els.minComponent, $("minComponentValue"), extractionSettingChanged);
els.centerlineNms.addEventListener("change", extractionSettingChanged);
bindRange(els.overlayOpacity, $("overlayOpacityValue"), scheduleAutosave);
els.overlayOpacity.addEventListener("change", rerenderOverlayOpacity);
bindRange(els.localStrength, $("localStrengthValue"), featureSettingChanged);
bindRange(els.localWindow, $("localWindowValue"), featureSettingChanged);
bindRange(els.referenceBrush, $("referenceBrushValue"), () => {
  const normalized = normalizedReferenceWidth();
  if (Number(els.referenceBrush.value) !== normalized) setRangeValue(els.referenceBrush, normalized);
  clearLocalCalibration(true);
  if (state.preview && state.referenceCenterline) {
    renderReferenceCanvas();
    renderNegativeCanvas(false, true);
    scheduleClosedFillRefresh();
    if (!state.comparisonMode) renderNormalOverlay();
    updateMetrics();
  }
  scheduleAutosave();
});
els.referenceBrush.addEventListener("change", () => {
  if (state.comparisonMode && state.analysisMask && hasReference()) compareCurrent(false);
});
bindRange(els.referenceOpacity, $("referenceOpacityValue"), scheduleAutosave);
els.referenceOpacity.addEventListener("change", () => {
  if (state.preview && state.referenceCenterline) {
    // Opacity does not change annotation geometry; redraw only after slider release.
    renderReferenceCanvas(false);
    renderNegativeCanvas(false, false);
  }
});
bindRange(els.reviewRadius, $("reviewRadiusValue"), scheduleAutosave);
const gapSettingChanged = () => {
  const wasComparison = state.comparisonMode;
  const gapWasApplied = Boolean(state.gapBaseMask);
  if (gapWasApplied) {
    state.analysisMask = state.gapBaseMask;
    state.gapBaseMask = null;
    state.gapApplied = null;
  }
  clearGapProposal();
  state.lastTopology = null;
  if (els.topologyStatus) {
    els.topologyStatus.textContent = "Topology v3.0: Gap設定変更後は未実行";
  }
  if (gapWasApplied && state.analysisMask) {
    if (wasComparison && hasReference()) compareCurrent(false);
    else {
      renderNormalOverlay();
      updateMetrics();
    }
    els.gapStatus.textContent = "Gap Bridge: 設定変更のため適用を自動解除しました";
  }
  updateControls();
  scheduleAutosave();
};
bindRange(els.gapMaxDistance, $("gapMaxDistanceValue"), gapSettingChanged);
bindRange(els.extendedGapMaxDistance, $("extendedGapMaxDistanceValue"), gapSettingChanged);
bindRange(els.gapAngle, $("gapAngleValue"), gapSettingChanged);
bindRange(els.gapMinScore, $("gapMinScoreValue"), gapSettingChanged);
els.localEnabled.addEventListener("change", featureSettingChanged);
els.borderAssistedFill.addEventListener("change", scheduleAutosave);
els.autosaveEnabled.addEventListener("change", () => {
  if (els.autosaveEnabled.checked) scheduleAutosave();
  else {
    cancelScheduledAutosave();
    els.projectStatus.textContent = "自動保存OFF";
  }
});

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

function beginPan(event, button = event.button) {
  if (!state.preview || state.dragging) return false;
  state.dragging = true;
  state.dragPointerId = event.pointerId;
  state.dragButton = button;
  state.dragOrigin = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
  els.viewer.classList.add("dragging");
  els.viewer.setPointerCapture(event.pointerId);
  event.preventDefault();
  return true;
}

els.viewer.addEventListener("pointerdown", event => {
  if (!state.preview) return;

  // Middle-button drag is a temporary pan gesture in every annotation tool.
  if (event.button === 1) {
    beginPan(event, 1);
    return;
  }
  if (event.button !== 0) return;

  if (state.tool === "exclusion") { beginRectInteraction(event, "exclusion"); return; }
  if (state.tool === "full-roi") { beginRectInteraction(event, "roi"); return; }
  if (state.tool === "closed-negative-fill") { addClosedNegativeFill(event); return; }
  if (state.tool !== "pan") { beginReferenceDraw(event); return; }
  beginPan(event, 0);
});

els.viewer.addEventListener("pointermove", event => {
  if (state.dragging && state.dragOrigin && event.pointerId === state.dragPointerId) {
    state.tx = state.dragOrigin.tx + event.clientX - state.dragOrigin.x;
    state.ty = state.dragOrigin.ty + event.clientY - state.dragOrigin.y;
    scheduleTransform();
    return;
  }
  if (state.rectInteraction) { continueRectInteraction(event); return; }
  if (state.drawingReference) { continueReferenceDraw(event); }
});

function endPointer(event) {
  if (state.dragging && event.pointerId === state.dragPointerId) {
    state.dragging = false;
    state.dragPointerId = null;
    state.dragButton = null;
    state.dragOrigin = null;
    els.viewer.classList.remove("dragging");
    if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
      els.viewer.releasePointerCapture(event.pointerId);
    }
    return;
  }
  if (state.rectInteraction) endRectInteraction(event);
  if (state.drawingReference) endReferenceDraw(event);
}
els.viewer.addEventListener("pointerup", endPointer);
els.viewer.addEventListener("pointercancel", endPointer);
els.viewer.addEventListener("auxclick", event => {
  if (event.button === 1) event.preventDefault();
});
els.viewer.addEventListener("lostpointercapture", event => {
  if (state.dragging && event.pointerId === state.dragPointerId) {
    state.dragging = false;
    state.dragPointerId = null;
    state.dragButton = null;
    state.dragOrigin = null;
    els.viewer.classList.remove("dragging");
  }
});

window.addEventListener("keydown", event => {
  if (!state.preview || state.busy) return;

  const targetTag = event.target?.tagName?.toLowerCase();
  const editingControl = targetTag === "input" || targetTag === "textarea" || targetTag === "select";
  const plainKey = !(event.ctrlKey || event.metaKey || event.altKey);
  const keyLower = event.key.toLowerCase();

  if (!editingControl && plainKey && keyLower === "h") {
    setOverlayPeekHidden(true);
    event.preventDefault();
    return;
  }
  if (!editingControl && plainKey && keyLower === "v" && !event.repeat && state.analysisMask) {
    toggleAnnotationAssist();
    event.preventDefault();
    return;
  }

  if ((event.key === "Delete" || event.key === "Backspace") && !(event.ctrlKey || event.metaKey)) {
    const tag = event.target?.tagName?.toLowerCase();
    if (tag !== "input" && tag !== "textarea") {
      const deleted = state.tool === "exclusion"
        ? deleteSelectedRect("exclusion")
        : state.tool === "full-roi"
          ? deleteSelectedRect("roi")
          : false;
      if (deleted) event.preventDefault();
    }
    return;
  }

  if (!(event.ctrlKey || event.metaKey)) return;
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

window.addEventListener("keyup", event => {
  if (event.key.toLowerCase() === "h") setOverlayPeekHidden(false);
});
window.addEventListener("blur", () => setOverlayPeekHidden(false));

window.addEventListener("resize", () => { if (state.preview) fitToViewer(); });

renderHistory();
els.projectStatus.textContent = `v${APP_VERSION} / ${ALGORITHM_VERSION}`;
updateAnnotationStatus();
updateLocalCalibrationStatus();
updateTopologyStatus();
applyAnnotationAssistView();
updateControls();
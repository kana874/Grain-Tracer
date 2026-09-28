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
import { dilateBinaryMask } from "./evaluation.js";

const $ = id => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  projectInput: $("projectInput"),
  dropZone: $("dropZone"),
  viewer: $("viewer"),
  canvasStage: $("canvasStage"),
  imageCanvas: $("imageCanvas"),
  overlayCanvas: $("overlayCanvas"),
  referenceCanvas: $("referenceCanvas"),
  emptyState: $("emptyState"),
  panToolButton: $("panToolButton"),
  referenceToolButton: $("referenceToolButton"),
  eraseReferenceToolButton: $("eraseReferenceToolButton"),
  fitButton: $("fitButton"),
  actualButton: $("actualButton"),
  clearOverlayButton: $("clearOverlayButton"),
  analyzeButton: $("analyzeButton"),
  compareButton: $("compareButton"),
  autoTuneButton: $("autoTuneButton"),
  localTuneButton: $("localTuneButton"),
  clearLocalCalibrationButton: $("clearLocalCalibrationButton"),
  clearReferenceButton: $("clearReferenceButton"),
  showNormalButton: $("showNormalButton"),
  saveProjectButton: $("saveProjectButton"),
  loadProjectButton: $("loadProjectButton"),
  autosaveEnabled: $("autosaveEnabled"),
  zoomLabel: $("zoomLabel"),
  statusText: $("statusText"),
  progressBar: $("progressBar"),
  sensitivity: $("sensitivity"),
  darkWeight: $("darkWeight"),
  ridgeWeight: $("ridgeWeight"),
  colorWeight: $("colorWeight"),
  minComponent: $("minComponent"),
  overlayOpacity: $("overlayOpacity"),
  localEnabled: $("localEnabled"),
  localStrength: $("localStrength"),
  localWindow: $("localWindow"),
  referenceBrush: $("referenceBrush"),
  reviewRadius: $("reviewRadius"),
  metricPrecision: $("metricPrecision"),
  metricRecall: $("metricRecall"),
  metricF1: $("metricF1"),
  metricDetail: $("metricDetail"),
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
  analysisMask: null,
  referenceMask: null,
  referenceCenterline: null,
  referenceCount: 0,
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
  els.eraseReferenceToolButton.disabled = disabled || !hasPreview || !hasRef;
  els.compareButton.disabled = disabled || !hasAnalysis || !hasRef;
  els.autoTuneButton.disabled = disabled || !hasPreview || !hasRef;
  els.localTuneButton.disabled = disabled || !hasPreview || !hasRef;
  els.clearLocalCalibrationButton.disabled = disabled || !state.localCalibration;
  els.clearReferenceButton.disabled = disabled || !hasRef;
  els.showNormalButton.disabled = disabled || !state.comparisonMode;
  els.saveProjectButton.disabled = disabled || !hasPreview || !state.sourceFingerprint;
  els.loadProjectButton.disabled = disabled || !hasPreview;
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
  for (const canvas of [els.imageCanvas, els.overlayCanvas, els.referenceCanvas]) {
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

function currentBoundaryOptions() {
  return {
    ...currentExtractionOptions(),
    localCalibration: state.localCalibration,
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
    referenceBrush: Number(els.referenceBrush.value),
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
    els.metricPrecision.textContent = "-";
    els.metricRecall.textContent = "-";
    els.metricF1.textContent = "-";
    els.metricDetail.textContent = hasReference()
      ? "自動抽出後に「比較」を押してください。"
      : "お手本線を描くと比較できます。";
    return;
  }
  els.metricPrecision.textContent = `${(metrics.precision * 100).toFixed(1)}%`;
  els.metricRecall.textContent = `${(metrics.recall * 100).toFixed(1)}%`;
  els.metricF1.textContent = `${(metrics.f1 * 100).toFixed(1)}%`;
  els.metricDetail.textContent = `自動線: 一致 ${metrics.matchedPrediction.toLocaleString()} / 誤検出 ${metrics.falsePositive.toLocaleString()} px　お手本: 一致 ${metrics.matchedReference.toLocaleString()} / 見逃し ${metrics.falseNegative.toLocaleString()} px`;
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
    const f1 = item.metrics?.f1 == null ? "-" : `${(item.metrics.f1 * 100).toFixed(1)}%`;
    const label = item.kind === "auto-tune" ? "全体調整" : item.kind === "local-tune" ? "局所調整" : "比較";
    li.innerHTML = `<strong>${label}</strong><span>F1 ${f1}</span><small>${date.toLocaleString("ja-JP")}</small>`;
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
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      matchedPrediction: metrics.matchedPrediction,
      falsePositive: metrics.falsePositive,
      matchedReference: metrics.matchedReference,
      falseNegative: metrics.falseNegative,
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
    rgba[i] = 255; rgba[i + 1] = 216; rgba[i + 2] = 74; rgba[i + 3] = 242;
  }
  els.referenceCanvas.getContext("2d").putImageData(new ImageData(rgba, state.preview.width, state.preview.height), 0, 0);
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
  updateMetrics();
  updateControls();
  setStatus("粒界オーバーレイを消去しました。");
}

function clearReference() {
  if (!state.preview) return;
  clearLocalCalibration(true);
  state.referenceMask = new Uint8Array(state.preview.width * state.preview.height);
  state.referenceCenterline = new Uint8Array(state.preview.width * state.preview.height);
  state.referenceCount = 0;
  els.referenceCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  renderNormalOverlay();
  updateMetrics();
  setTool("pan");
  updateControls();
  setStatus("お手本線をすべて消去しました。");
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
  state.referenceCount = state.referenceCenterline.reduce((sum, value) => sum + value, 0);
  state.history = Array.isArray(project.history) ? project.history : [];
  state.localCalibration = project.localCalibration ?? null;
  applySettings(project.settings ?? {});
  updateLocalCalibrationStatus();
  renderReferenceCanvas();
  renderHistory();
  state.analysisMask = null;
  renderNormalOverlay();
  updateMetrics();
  updateControls();
  els.projectStatus.textContent = `${source}を復元しました`;
  setStatus(`${source}を復元しました。お手本中心線: ${state.referenceCount.toLocaleString()} px`, 100);
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
    prepareCanvas(preview.width, preview.height);
    els.imageCanvas.getContext("2d").putImageData(preview.imageData, 0, 0);
    els.overlayCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.referenceCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
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
  setStatus(`特徴量を計算中... Dark Ridge + ${options.localEnabled ? "局所適応" : "全体基準"}`, 1);
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
    currentComparisonOptions(),
  );
  els.overlayCanvas.getContext("2d").putImageData(result.imageData, 0, 0);
  els.referenceCanvas.style.visibility = "hidden";
  state.comparisonMode = true;
  updateMetrics(result.metrics);
  updateControls();
  if (record) addHistory("compare", result.metrics);
  setStatus(`比較完了: Precision ${(result.metrics.precision * 100).toFixed(1)}% / Recall ${(result.metrics.recall * 100).toFixed(1)}% / F1 ${(result.metrics.f1 * 100).toFixed(1)}%`, 100);
  return result;
}

async function autoTune() {
  if (!state.preview || !hasReference()) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    setStatus("お手本と比較してDark/Ridge/Colorを自動調整中...", 1);
    const result = await autoTuneBoundary(features, state.referenceCenterline, {
      ...currentComparisonOptions(),
      current: currentExtractionOptions(),
      onProgress: ratio => setStatus(`自動調整中... ${Math.round(ratio * 100)}%`, ratio * 99),
    });
    setRangeValue(els.sensitivity, result.parameters.sensitivity);
    setRangeValue(els.darkWeight, result.parameters.darkWeight);
    setRangeValue(els.ridgeWeight, result.parameters.ridgeWeight);
    setRangeValue(els.colorWeight, result.parameters.colorWeight);
    setRangeValue(els.minComponent, result.parameters.minComponent);
    state.localCalibration = null;
    updateLocalCalibrationStatus();
    state.analysisMask = result.mask;

    const comparison = renderComparisonOverlay(
      result.mask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentComparisonOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    els.referenceCanvas.style.visibility = "hidden";
    state.comparisonMode = true;
    updateMetrics(comparison.metrics);
    addHistory("auto-tune", comparison.metrics, "global ridge-weight tuning");
    setStatus(`自動調整完了: F1 ${(comparison.metrics.f1 * 100).toFixed(1)}% / 感度 ${result.parameters.sensitivity} / 暗さ ${result.parameters.darkWeight} / Ridge ${result.parameters.ridgeWeight} / 色差 ${result.parameters.colorWeight}`, 100);
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
    setStatus("お手本を使って範囲ごとの感度を調整中...", 1);
    const calibration = await tuneLocalSensitivity(features, state.referenceCenterline, {
      ...currentComparisonOptions(),
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
      onProgress: ratio => setStatus(`局所補正で再抽出中... ${Math.round(ratio * 100)}%`, 62 + ratio * 36),
    });

    const comparison = renderComparisonOverlay(
      state.analysisMask,
      state.referenceCenterline,
      state.preview.width,
      state.preview.height,
      currentComparisonOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    els.referenceCanvas.style.visibility = "hidden";
    state.comparisonMode = true;
    updateMetrics(comparison.metrics);
    addHistory("local-tune", comparison.metrics, "4x4 reference-guided sensitivity calibration");
    const measured = calibration.measured.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    setStatus(
      `局所調整完了: F1 ${(comparison.metrics.f1 * 100).toFixed(1)}% / お手本校正 ${measured}/${calibration.cols * calibration.rows}領域`,
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
  els.eraseReferenceToolButton.classList.toggle("active", tool === "erase-reference");
  els.viewer.classList.toggle("reference-mode", tool !== "pan");
}

function eventToPreviewPoint(event) {
  if (!state.preview) return null;
  const rect = els.viewer.getBoundingClientRect();
  const x = ((event.clientX - rect.left) - state.tx) / state.scale;
  const y = ((event.clientY - rect.top) - state.ty) / state.scale;
  if (x < 0 || y < 0 || x >= state.preview.width || y >= state.preview.height) return null;
  return { x, y };
}

function paintDisk(mask, width, height, cx, cy, radius, value) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius));
  const rr = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= rr) mask[y * width + x] = value;
    }
  }
}

function paintReferenceSegment(from, to, erase) {
  const width = state.preview.width;
  const height = state.preview.height;
  const eraseRadius = Math.max(1, referenceJudgementRadius());
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    if (erase) {
      paintDisk(state.referenceCenterline, width, height, cx, cy, eraseRadius, 0);
    } else {
      const sx = Math.max(0, Math.min(width - 1, Math.round(cx)));
      const sy = Math.max(0, Math.min(height - 1, Math.round(cy)));
      state.referenceCenterline[sy * width + sx] = 1;
    }
  }
  if (!erase) state.referenceCount = Math.max(1, state.referenceCount);
}

function drawReferenceCanvasSegment(from, to, erase) {
  const ctx = els.referenceCanvas.getContext("2d");
  const brush = normalizedReferenceWidth();
  ctx.save();
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "rgba(255, 216, 74, 0.95)";
  ctx.fillStyle = "rgba(255, 216, 74, 0.95)";
  ctx.lineWidth = brush;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (Math.hypot(to.x - from.x, to.y - from.y) < 0.5) {
    ctx.beginPath(); ctx.arc(to.x, to.y, brush / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  ctx.restore();
}

function beginReferenceDraw(event) {
  const point = eventToPreviewPoint(event);
  if (!point) return false;
  if (state.comparisonMode) showNormalView();
  if (state.localCalibration) clearLocalCalibration(true);
  state.drawingReference = true;
  state.lastReferencePoint = point;
  const erase = state.tool === "erase-reference";
  paintReferenceSegment(point, point, erase);
  drawReferenceCanvasSegment(point, point, erase);
  updateMetrics();
  updateControls();
  els.viewer.setPointerCapture(event.pointerId);
  return true;
}

function continueReferenceDraw(event) {
  if (!state.drawingReference || !state.lastReferencePoint) return;
  const point = eventToPreviewPoint(event);
  if (!point) return;
  const erase = state.tool === "erase-reference";
  paintReferenceSegment(state.lastReferencePoint, point, erase);
  drawReferenceCanvasSegment(state.lastReferencePoint, point, erase);
  state.lastReferencePoint = point;
}

function endReferenceDraw(event) {
  if (!state.drawingReference) return;
  state.drawingReference = false;
  state.lastReferencePoint = null;
  state.referenceCount = state.referenceCenterline.reduce((sum, value) => sum + value, 0);
  renderReferenceCanvas();
  updateMetrics();
  updateControls();
  setStatus(`お手本を更新しました。中心線: ${state.referenceCount.toLocaleString()} px`);
  scheduleAutosave();
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) els.viewer.releasePointerCapture(event.pointerId);
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
els.showNormalButton.addEventListener("click", showNormalView);
els.saveProjectButton.addEventListener("click", saveProjectManual);
els.loadProjectButton.addEventListener("click", () => els.projectInput.click());
els.panToolButton.addEventListener("click", () => setTool("pan"));
els.referenceToolButton.addEventListener("click", () => setTool("reference"));
els.eraseReferenceToolButton.addEventListener("click", () => setTool("erase-reference"));

bindRange(els.sensitivity, $("sensitivityValue"), extractionSettingChanged);
bindRange(els.darkWeight, $("darkWeightValue"), extractionSettingChanged);
bindRange(els.ridgeWeight, $("ridgeWeightValue"), extractionSettingChanged);
bindRange(els.colorWeight, $("colorWeightValue"), extractionSettingChanged);
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
    if (state.comparisonMode && state.analysisMask && hasReference()) compareCurrent(false);
    else renderNormalOverlay();
    updateMetrics();
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
  if (state.tool !== "pan") { beginReferenceDraw(event); return; }
  state.dragging = true;
  state.dragOrigin = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
  els.viewer.classList.add("dragging");
  els.viewer.setPointerCapture(event.pointerId);
});
els.viewer.addEventListener("pointermove", event => {
  if (state.drawingReference) { continueReferenceDraw(event); return; }
  if (!state.dragging || !state.dragOrigin) return;
  state.tx = state.dragOrigin.tx + event.clientX - state.dragOrigin.x;
  state.ty = state.dragOrigin.ty + event.clientY - state.dragOrigin.y;
  applyTransform();
});
function endPointer(event) {
  if (state.drawingReference) endReferenceDraw(event);
  if (!state.dragging) return;
  state.dragging = false;
  state.dragOrigin = null;
  els.viewer.classList.remove("dragging");
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) els.viewer.releasePointerCapture(event.pointerId);
}
els.viewer.addEventListener("pointerup", endPointer);
els.viewer.addEventListener("pointercancel", endPointer);
window.addEventListener("resize", () => { if (state.preview) fitToViewer(); });

renderHistory();
els.projectStatus.textContent = `v${APP_VERSION} / ${ALGORITHM_VERSION}`;
updateLocalCalibrationStatus();
updateControls();
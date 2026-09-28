import { BmpError, parseBmpHeader, decodeBmpPreview } from "./bmp.js";
import {
  autoTuneBoundary,
  buildBoundaryMask,
  compareBoundaryMasks,
  computeBoundaryFeatures,
  renderBoundaryOverlay,
  renderComparisonOverlay,
} from "./analysis.js";

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
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
  clearReferenceButton: $("clearReferenceButton"),
  showNormalButton: $("showNormalButton"),
  zoomLabel: $("zoomLabel"),
  statusText: $("statusText"),
  progressBar: $("progressBar"),
  sensitivity: $("sensitivity"),
  darkWeight: $("darkWeight"),
  colorWeight: $("colorWeight"),
  minComponent: $("minComponent"),
  overlayOpacity: $("overlayOpacity"),
  referenceBrush: $("referenceBrush"),
  tolerance: $("tolerance"),
  reviewRadius: $("reviewRadius"),
  metricPrecision: $("metricPrecision"),
  metricRecall: $("metricRecall"),
  metricF1: $("metricF1"),
  metricDetail: $("metricDetail"),
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
  referenceCount: 0,
  comparisonMode: false,
  busy: false,
  abortController: null,
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
  els.clearReferenceButton.disabled = disabled || !hasRef;
  els.showNormalButton.disabled = disabled || !state.comparisonMode;
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
    colorWeight: Number(els.colorWeight.value),
    minComponent: Number(els.minComponent.value),
  };
}

function currentComparisonOptions() {
  return {
    tolerance: Number(els.tolerance.value),
    reviewRadius: Number(els.reviewRadius.value),
    opacity: Number(els.overlayOpacity.value),
  };
}

function updateMetrics(metrics = null) {
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
  els.metricDetail.textContent = `一致候補 ${metrics.matchedPrediction.toLocaleString()} px / 誤検出 ${metrics.falsePositive.toLocaleString()} px / 見逃し ${metrics.falseNegative.toLocaleString()} px`;
}

function renderNormalOverlay() {
  if (!state.preview) return;
  const ctx = els.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, state.preview.width, state.preview.height);
  if (state.analysisMask) {
    const overlay = renderBoundaryOverlay(state.analysisMask, state.preview.width, state.preview.height, {
      opacity: Number(els.overlayOpacity.value),
    });
    ctx.putImageData(overlay, 0, 0);
  }
  els.referenceCanvas.style.visibility = "visible";
  state.comparisonMode = false;
  updateControls();
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
  state.referenceMask = new Uint8Array(state.preview.width * state.preview.height);
  state.referenceCount = 0;
  els.referenceCanvas.getContext("2d").clearRect(0, 0, state.preview.width, state.preview.height);
  renderNormalOverlay();
  updateMetrics();
  setTool("pan");
  updateControls();
  setStatus("お手本線をすべて消去しました。");
}

async function loadBmp(file) {
  if (!file) return;
  state.abortController?.abort();
  state.abortController = new AbortController();
  setBusy(true);
  clearOverlay();
  resetMetadata();
  state.features = null;
  state.referenceCount = 0;
  state.referenceMask = null;

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
      onProgress: ratio => setStatus(`縮小プレビューを作成中... ${Math.round(ratio * 100)}%`, 5 + ratio * 85),
    });

    state.preview = preview;
    state.referenceMask = new Uint8Array(preview.width * preview.height);
    prepareCanvas(preview.width, preview.height);
    els.imageCanvas.getContext("2d").putImageData(preview.imageData, 0, 0);
    els.overlayCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.referenceCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.canvasStage.style.display = "block";
    els.emptyState.style.display = "none";
    setTool("pan");
    fitToViewer();
    updateMetrics();

    setStatus(
      `読込完了: ${header.width.toLocaleString()} × ${header.height.toLocaleString()} px → preview ${preview.width} × ${preview.height} px`,
      100,
    );
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error(error);
    state.file = null;
    state.header = null;
    state.preview = null;
    state.features = null;
    state.referenceMask = null;
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
  if (state.features) return state.features;
  if (!state.preview) throw new Error("画像がありません。");

  setStatus("粒界特徴量を計算中...", 2);
  state.features = await computeBoundaryFeatures(state.preview.imageData, {
    onProgress: ratio => setStatus(`粒界特徴量を計算中... ${Math.round(ratio * 100)}%`, ratio * 65),
  });
  return state.features;
}

async function analyzePreview() {
  if (!state.preview) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    setStatus("粒界候補を解析中...", 65);
    const mask = await buildBoundaryMask(features, {
      ...currentExtractionOptions(),
      onProgress: ratio => setStatus(`粒界候補を解析中... ${Math.round(ratio * 100)}%`, 65 + ratio * 34),
    });
    state.analysisMask = mask;
    renderNormalOverlay();
    updateMetrics();
    const count = mask.reduce((sum, value) => sum + value, 0);
    setStatus(`粒界候補を表示しました。候補画素: ${count.toLocaleString()}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`解析エラー: ${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

function compareCurrent() {
  if (!state.preview || !state.analysisMask || !hasReference()) return;
  const result = renderComparisonOverlay(
    state.analysisMask,
    state.referenceMask,
    state.preview.width,
    state.preview.height,
    currentComparisonOptions(),
  );
  els.overlayCanvas.getContext("2d").putImageData(result.imageData, 0, 0);
  els.referenceCanvas.style.visibility = "hidden";
  state.comparisonMode = true;
  updateMetrics(result.metrics);
  updateControls();
  setStatus(`比較完了: F1 ${(result.metrics.f1 * 100).toFixed(1)}%`, 100);
}

function setRangeValue(input, value) {
  input.value = String(Math.round(value));
  const output = $(`${input.id}Value`);
  if (output) output.value = input.value;
}

async function autoTune() {
  if (!state.preview || !hasReference()) return;
  setBusy(true);
  try {
    const features = await ensureFeatures();
    setStatus("お手本と比較して自動調整中...", 1);
    const result = await autoTuneBoundary(features, state.referenceMask, {
      ...currentComparisonOptions(),
      current: currentExtractionOptions(),
      onProgress: ratio => setStatus(`自動調整中... ${Math.round(ratio * 100)}%`, ratio * 99),
    });

    setRangeValue(els.sensitivity, result.parameters.sensitivity);
    setRangeValue(els.darkWeight, result.parameters.darkWeight);
    setRangeValue(els.colorWeight, result.parameters.colorWeight);
    setRangeValue(els.minComponent, result.parameters.minComponent);
    state.analysisMask = result.mask;

    const comparison = renderComparisonOverlay(
      result.mask,
      state.referenceMask,
      state.preview.width,
      state.preview.height,
      currentComparisonOptions(),
    );
    els.overlayCanvas.getContext("2d").putImageData(comparison.imageData, 0, 0);
    els.referenceCanvas.style.visibility = "hidden";
    state.comparisonMode = true;
    updateMetrics(comparison.metrics);
    setStatus(
      `自動調整完了: F1 ${(comparison.metrics.f1 * 100).toFixed(1)}% / 感度 ${result.parameters.sensitivity} / 暗線 ${result.parameters.darkWeight} / 色差 ${result.parameters.colorWeight} / 最小連結 ${result.parameters.minComponent}`,
      100,
    );
  } catch (error) {
    console.error(error);
    setStatus(`自動調整エラー: ${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

function rerenderOverlayOpacity() {
  if (!state.analysisMask || !state.preview) return;
  if (state.comparisonMode && hasReference()) compareCurrent();
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

function paintReferenceMaskSegment(from, to, erase) {
  const width = state.preview.width;
  const height = state.preview.height;
  const brush = Number(els.referenceBrush.value);
  const radius = Math.max(1, brush / 2);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  let delta = 0;

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));
    const rr = radius * radius;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const ddx = x - cx;
        const ddy = y - cy;
        if (ddx * ddx + ddy * ddy > rr) continue;
        const p = y * width + x;
        const oldValue = state.referenceMask[p];
        const newValue = erase ? 0 : 1;
        if (oldValue === newValue) continue;
        state.referenceMask[p] = newValue;
        delta += newValue ? 1 : -1;
      }
    }
  }

  state.referenceCount = Math.max(0, state.referenceCount + delta);
}

function drawReferenceCanvasSegment(from, to, erase) {
  const ctx = els.referenceCanvas.getContext("2d");
  const brush = Number(els.referenceBrush.value);
  ctx.save();
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "rgba(255, 216, 74, 0.95)";
  ctx.fillStyle = "rgba(255, 216, 74, 0.95)";
  ctx.lineWidth = brush;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 0.5) {
    ctx.beginPath();
    ctx.arc(to.x, to.y, brush / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.restore();
}

function beginReferenceDraw(event) {
  const point = eventToPreviewPoint(event);
  if (!point) return false;
  if (state.comparisonMode) showNormalView();
  state.drawingReference = true;
  state.lastReferencePoint = point;
  const erase = state.tool === "erase-reference";
  paintReferenceMaskSegment(point, point, erase);
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
  paintReferenceMaskSegment(state.lastReferencePoint, point, erase);
  drawReferenceCanvasSegment(state.lastReferencePoint, point, erase);
  state.lastReferencePoint = point;
}

function endReferenceDraw(event) {
  if (!state.drawingReference) return;
  state.drawingReference = false;
  state.lastReferencePoint = null;
  updateMetrics();
  updateControls();
  setStatus(`お手本を更新しました。お手本画素: ${state.referenceCount.toLocaleString()}`);
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}

els.fileInput.addEventListener("change", event => loadBmp(event.target.files?.[0]));
els.fitButton.addEventListener("click", fitToViewer);
els.actualButton.addEventListener("click", actualSize);
els.clearOverlayButton.addEventListener("click", clearOverlay);
els.analyzeButton.addEventListener("click", analyzePreview);
els.compareButton.addEventListener("click", compareCurrent);
els.autoTuneButton.addEventListener("click", autoTune);
els.clearReferenceButton.addEventListener("click", clearReference);
els.showNormalButton.addEventListener("click", showNormalView);
els.panToolButton.addEventListener("click", () => setTool("pan"));
els.referenceToolButton.addEventListener("click", () => setTool("reference"));
els.eraseReferenceToolButton.addEventListener("click", () => setTool("erase-reference"));

bindRange(els.sensitivity, $("sensitivityValue"));
bindRange(els.darkWeight, $("darkWeightValue"));
bindRange(els.colorWeight, $("colorWeightValue"));
bindRange(els.minComponent, $("minComponentValue"));
bindRange(els.overlayOpacity, $("overlayOpacityValue"), rerenderOverlayOpacity);
bindRange(els.referenceBrush, $("referenceBrushValue"));
bindRange(els.tolerance, $("toleranceValue"), () => {
  if (state.comparisonMode && state.analysisMask && hasReference()) compareCurrent();
});
bindRange(els.reviewRadius, $("reviewRadiusValue"), () => {
  if (state.comparisonMode && state.analysisMask && hasReference()) compareCurrent();
});

for (const type of ["dragenter", "dragover"]) {
  els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.add("dragover");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.dropZone.addEventListener(type, event => {
    event.preventDefault();
    els.dropZone.classList.remove("dragover");
  });
}
els.dropZone.addEventListener("drop", event => {
  const file = [...(event.dataTransfer?.files ?? [])].find(item => item.name.toLowerCase().endsWith(".bmp"));
  if (!file) {
    setStatus("BMPファイルをドロップしてください。");
    return;
  }
  loadBmp(file);
});

els.viewer.addEventListener("wheel", event => {
  if (!state.preview) return;
  event.preventDefault();
  const rect = els.viewer.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const previous = state.scale;
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.scale = Math.max(0.02, Math.min(8, state.scale * factor));
  const imageX = (mx - state.tx) / previous;
  const imageY = (my - state.ty) / previous;
  state.tx = mx - imageX * state.scale;
  state.ty = my - imageY * state.scale;
  applyTransform();
}, { passive: false });

els.viewer.addEventListener("pointerdown", event => {
  if (!state.preview || event.button !== 0 || state.busy) return;

  if (state.tool !== "pan") {
    beginReferenceDraw(event);
    return;
  }

  state.dragging = true;
  state.dragOrigin = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
  els.viewer.classList.add("dragging");
  els.viewer.setPointerCapture(event.pointerId);
});

els.viewer.addEventListener("pointermove", event => {
  if (state.drawingReference) {
    continueReferenceDraw(event);
    return;
  }
  if (!state.dragging || !state.dragOrigin) return;
  state.tx = state.dragOrigin.tx + event.clientX - state.dragOrigin.x;
  state.ty = state.dragOrigin.ty + event.clientY - state.dragOrigin.y;
  applyTransform();
});

function endPointerAction(event) {
  if (state.drawingReference) {
    endReferenceDraw(event);
    return;
  }
  if (!state.dragging) return;
  state.dragging = false;
  state.dragOrigin = null;
  els.viewer.classList.remove("dragging");
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}

els.viewer.addEventListener("pointerup", endPointerAction);
els.viewer.addEventListener("pointercancel", endPointerAction);

window.addEventListener("resize", () => {
  if (state.preview) fitToViewer();
});

updateControls();

import { BmpError, parseBmpHeader, decodeBmpPreview } from "./bmp.js";
import { extractBoundaryCandidates, renderBoundaryOverlay } from "./analysis.js";

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  dropZone: $("dropZone"),
  viewer: $("viewer"),
  canvasStage: $("canvasStage"),
  imageCanvas: $("imageCanvas"),
  overlayCanvas: $("overlayCanvas"),
  emptyState: $("emptyState"),
  fitButton: $("fitButton"),
  actualButton: $("actualButton"),
  clearOverlayButton: $("clearOverlayButton"),
  analyzeButton: $("analyzeButton"),
  zoomLabel: $("zoomLabel"),
  statusText: $("statusText"),
  progressBar: $("progressBar"),
  sensitivity: $("sensitivity"),
  darkWeight: $("darkWeight"),
  colorWeight: $("colorWeight"),
  minComponent: $("minComponent"),
  overlayOpacity: $("overlayOpacity"),
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
  scale: 1,
  tx: 0,
  ty: 0,
  dragging: false,
  dragOrigin: null,
  analysisMask: null,
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

function setBusy(busy) {
  els.fileInput.disabled = busy;
  els.analyzeButton.disabled = busy || !state.preview;
  els.fitButton.disabled = busy || !state.preview;
  els.actualButton.disabled = busy || !state.preview;
  els.clearOverlayButton.disabled = busy || !state.analysisMask;
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
  for (const canvas of [els.imageCanvas, els.overlayCanvas]) {
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

function clearOverlay() {
  const ctx = els.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  state.analysisMask = null;
  els.clearOverlayButton.disabled = true;
  setStatus("粒界オーバーレイを消去しました。");
}

async function loadBmp(file) {
  if (!file) return;
  state.abortController?.abort();
  state.abortController = new AbortController();
  setBusy(true);
  clearOverlay();
  resetMetadata();

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
    prepareCanvas(preview.width, preview.height);
    els.imageCanvas.getContext("2d").putImageData(preview.imageData, 0, 0);
    els.overlayCanvas.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    els.canvasStage.style.display = "block";
    els.emptyState.style.display = "none";
    fitToViewer();

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
    els.canvasStage.style.display = "none";
    els.emptyState.style.display = "grid";
    const message = error instanceof BmpError ? error.message : `読込エラー: ${error.message}`;
    setStatus(message, 0);
    alert(message);
  } finally {
    setBusy(false);
  }
}

async function analyzePreview() {
  if (!state.preview) return;
  setBusy(true);
  try {
    setStatus("粒界候補を解析中...", 1);
    const mask = await extractBoundaryCandidates(state.preview.imageData, {
      sensitivity: Number(els.sensitivity.value),
      darkWeight: Number(els.darkWeight.value),
      colorWeight: Number(els.colorWeight.value),
      minComponent: Number(els.minComponent.value),
      onProgress: ratio => setStatus(`粒界候補を解析中... ${Math.round(ratio * 100)}%`, ratio * 95),
    });
    state.analysisMask = mask;
    const overlay = renderBoundaryOverlay(mask, state.preview.width, state.preview.height, {
      opacity: Number(els.overlayOpacity.value),
    });
    els.overlayCanvas.getContext("2d").putImageData(overlay, 0, 0);
    els.clearOverlayButton.disabled = false;
    const count = mask.reduce((sum, value) => sum + value, 0);
    setStatus(`粒界候補を表示しました。候補画素: ${count.toLocaleString()}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`解析エラー: ${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

function rerenderOverlayOpacity() {
  if (!state.analysisMask || !state.preview) return;
  const overlay = renderBoundaryOverlay(state.analysisMask, state.preview.width, state.preview.height, {
    opacity: Number(els.overlayOpacity.value),
  });
  els.overlayCanvas.getContext("2d").putImageData(overlay, 0, 0);
}

function bindRange(input, output, onInput = null) {
  input.addEventListener("input", () => {
    output.value = input.value;
    if (onInput) onInput();
  });
}

els.fileInput.addEventListener("change", event => loadBmp(event.target.files?.[0]));
els.fitButton.addEventListener("click", fitToViewer);
els.actualButton.addEventListener("click", actualSize);
els.clearOverlayButton.addEventListener("click", clearOverlay);
els.analyzeButton.addEventListener("click", analyzePreview);

bindRange(els.sensitivity, $("sensitivityValue"));
bindRange(els.darkWeight, $("darkWeightValue"));
bindRange(els.colorWeight, $("colorWeightValue"));
bindRange(els.minComponent, $("minComponentValue"));
bindRange(els.overlayOpacity, $("overlayOpacityValue"), rerenderOverlayOpacity);

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
  if (!state.preview || event.button !== 0) return;
  state.dragging = true;
  state.dragOrigin = { x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
  els.viewer.classList.add("dragging");
  els.viewer.setPointerCapture(event.pointerId);
});
els.viewer.addEventListener("pointermove", event => {
  if (!state.dragging || !state.dragOrigin) return;
  state.tx = state.dragOrigin.tx + event.clientX - state.dragOrigin.x;
  state.ty = state.dragOrigin.ty + event.clientY - state.dragOrigin.y;
  applyTransform();
});
function endDrag(event) {
  if (!state.dragging) return;
  state.dragging = false;
  state.dragOrigin = null;
  els.viewer.classList.remove("dragging");
  if (event?.pointerId != null && els.viewer.hasPointerCapture(event.pointerId)) {
    els.viewer.releasePointerCapture(event.pointerId);
  }
}
els.viewer.addEventListener("pointerup", endDrag);
els.viewer.addEventListener("pointercancel", endDrag);

window.addEventListener("resize", () => {
  if (state.preview) fitToViewer();
});

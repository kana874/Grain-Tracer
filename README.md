# GrainTracer

GrainTracer is a browser-based grain-boundary extraction and annotation tool for Barker-etched polarized aluminum micrographs.

## Current status

**v0.3.6.1-alpha / boundary-v4-dendrite-negref**

Current capabilities:

- direct loading of very large uncompressed BMP files without expanding the full source image to RGBA
- low-memory downsampled preview generation
- grain-boundary candidate extraction on the preview
- multi-scale Dark Ridge feature for suppressing dot-like intragranular structures
- direction-aware Lab color difference across the estimated boundary normal
- local adaptive normalization for illumination and colour unevenness
- user-drawn reference boundaries with canonical display/judgement geometry
- adjustable semi-transparent reference display
- reference Undo / Redo with keyboard shortcuts and changed-pixel history
- user-labelled non-boundary examples for explicit false-positive suppression during tuning
- closed-region Negative Fill: click inside a grain enclosed by Positive reference lines to label its safe interior as non-boundary
- Partial Label evaluation: Positive / Negative / Unknown, with unlabelled predictions excluded from false-positive counts
- whole-image Positive Recall / pixel-weighted Negative Leakage / region-balanced Macro Negative Leakage / Alignment Error metrics
- complete-evaluation ROIs that report formal True Precision / Recall / F1 only where the user declares all boundaries labelled
- automatic 1 / 2 / 3 / 4 px Multi-Tolerance diagnostics
- editable rectangular exclusion regions with move, edge/corner resize, Delete, Undo and Redo
- orange non-boundary annotations for improved visibility on purple/magenta Barker images
- Auto Tune v2: CPU-only coordinate-descent tuning of Sensitivity / Dark / Ridge / Color / Dendrite / MinComponent, including zero feature weights and ablation diagnostics
- reference-guided 4×4 local sensitivity calibration with smooth interpolation
- 4×4 regional evaluation data
- evaluation history
- project JSON save/load
- IndexedDB autosave keyed to a lightweight source-image fingerprint

The original microscopy BMP is treated as read-only. Grain boundaries and reference information are stored separately.

## Run

GrainTracer is designed to run directly from GitHub Pages:

https://kana874.github.io/Grain-Tracer/

For local use, serve the repository with a static HTTP server, for example:

```bash
python -m http.server 8080
```

## BMP support

The current alpha supports:

- Windows BMP / DIB
- 24-bit BGR, uncompressed (BI_RGB)
- 32-bit BGRA, uncompressed (BI_RGB)

## v0.3 workflow

```text
Original BMP
  -> low-memory preview
  -> local normalization
  -> multi-scale Dark Ridge
  -> directional Lab colour difference
  -> dendrite orientation-difference feature
  -> boundary score
  -> Positive / Negative / Unknown Partial Label comparison
  -> optional closed-grain interior Negative Fill
  -> exclusion-mask filtering
  -> complete-evaluation ROI + Multi-Tolerance diagnostics
  -> Auto Tune v2 coordinate descent (ROI True F1 when available; otherwise Positive Recall + region-balanced Negative Leakage)
  -> reference-guided local sensitivity calibration
  -> evaluation history / project save
```

Full-resolution overlapping-tile analysis, local weight optimisation, compensation-map visualisation, Smart Trace, and final PNG / mask / SVG export remain planned.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

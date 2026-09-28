# GrainTracer

GrainTracer is a browser-based grain-boundary extraction and annotation tool for Barker-etched polarized aluminum micrographs.

## Current status

**v0.3.4-alpha / boundary-v4-dendrite-negref**

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
- rectangular exclusion regions for scale bars, labels, and other non-analysis content
- tolerant Precision / Recall / F1 comparison
- CPU-only automatic tuning of sensitivity and Dark / Ridge / Color / dendrite weights
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
  -> positive + non-boundary reference comparison
  -> exclusion-mask filtering
  -> CPU global auto-tune
  -> reference-guided local sensitivity calibration
  -> evaluation history / project save
```

Full-resolution overlapping-tile analysis, local weight optimisation, compensation-map visualisation, Smart Trace, and final PNG / mask / SVG export remain planned.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

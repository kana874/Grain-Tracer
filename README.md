# GrainTracer

GrainTracer is a browser-based grain-boundary extraction and annotation tool for Barker-etched polarized aluminum micrographs.

## Current status

**v0.3.6.7-alpha / boundary-v9-extended-gap-topology-diagnostic**

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
- click-to-fill closed grain interiors as high-confidence non-boundary examples, with a 3 px safety band from the positive reference
- closed-region fill seeds persisted in project JSON and regenerated from the current positive reference geometry
- closed-region fill acceleration using one connected-region index per positive-reference geometry, reused across seed operations
- middle-button drag temporary pan in every annotation tool without changing the active tool
- idle-time IndexedDB autosave and diagnostic performance timings for feature extraction, analysis, comparison, Auto Tune, annotation, fill rebuild, and autosave
- annotation-assist view that visually attenuates automatic boundaries and Negative overlays without changing analysis data; `H` temporarily hides the automatic overlay and `V` toggles assist view
- edge-aware scoring that renormalizes the boundary score over geometrically available features near image borders while guarding the outermost 1 preview pixel against frame artifacts
- optional continuous Ridge-normal non-maximum suppression (NMS): an axial continuous normal is estimated from the four sampled Ridge directions and the boundary score is bilinearly sampled across that normal to reduce thick/double responses to a centreline
- Topology v2.3: interior endpoint proxy, closed-fill core closure rates at 0/1/2/3 px probes, explicit single-edge/adjacent-corner Border-assisted closure checks, Safe Gap, and opt-in Extended Gap preview up to 8 preview pixels
- Safe Gap remains the conservative short-gap path; Extended Gap requires endpoint alignment plus Ridge/Color evidence along the missing path and remains manual-preview/manual-apply only
- Gap Preview classifies candidates by reason: Safe, Extended, Negative/Exclusion rejection, angle mismatch, distance excess, and score/evidence rejection
- Gap application records before/after closure snapshots, closed-region count change, and closure-rate change for diagnostic JSON export
- independent Negative validation holdout: whole Closed Negative Fill regions are split between tuning and validation so one grain interior never leaks into both sets
- deterministic Positive validation holdout using a 4×4 spatial grid and pixel-balanced cell selection to keep the validation share close to 20% even when one connected reference component is very large
- optional border-assisted Closed Negative Fill: a user-selected grain may use one image edge or two adjacent image edges as part of its closure, with area/contact safety checks and explicit seed persistence
- Partial Label evaluation: Positive / Negative / Unknown, with unlabelled predictions excluded from false-positive counts
- whole-image Positive Recall / Negative Leakage / Alignment Error metrics
- 4x4 region-balanced Macro Negative Leakage for spatially balanced Partial Label tuning
- complete-evaluation ROIs that report formal True Precision / Recall / F1 only where the user declares all boundaries labelled
- automatic 1 / 2 / 3 / 4 px Multi-Tolerance diagnostics
- editable rectangular exclusion regions with move, edge/corner resize, Delete, Undo and Redo
- orange non-boundary annotations for improved visibility on purple/magenta Barker images
- Auto Tune v2 search trace v4: CPU-only coordinate descent of Sensitivity / Dark / Ridge / Color / Dendrite / MinComponent; raw scoring proposes each coordinate move, processed post-NMS/component scoring must accept it, Ablation uses the same processed stage as the final objective, and before/after Closure is recorded as a diagnostic without affecting v0.3.6.7 optimization
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
  -> edge-aware boundary score (available-feature renormalization near borders)
  -> optional continuous Ridge-normal NMS centreline suppression
  -> Positive / Negative / Unknown Partial Label comparison
  -> exclusion-mask filtering
  -> complete-evaluation ROI + Multi-Tolerance diagnostics
  -> Auto Tune v2 coordinate descent (ROI True F1 when available; otherwise Positive Recall + Macro Negative Leakage)
  -> Closure diagnosis before/after Auto Tune (diagnostic only in v0.3.6.7)
  -> Safe / Extended Gap preview with manual application
  -> reference-guided local sensitivity calibration
  -> evaluation history / project save
```

Full-resolution overlapping-tile analysis, topology-aware Auto Tune optimization, stronger dendrite false-positive suppression, higher-resolution local calibration, Smart Trace, and final PNG / mask / SVG export remain planned. Safe and Extended Gap Bridge are opt-in and reversible; neither is silently applied by Auto Tune. In v0.3.6.7, topology is recorded for diagnosis only and is not part of the Auto Tune objective.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

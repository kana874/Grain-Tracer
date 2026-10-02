# GrainTracer

GrainTracer is a browser-based grain-boundary extraction and annotation tool for Barker-etched polarized aluminum micrographs.

## Current status

**v0.3.9.2-alpha / boundary-v13-precision-guide-v2**

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
- Topology v3.0: interior endpoint proxy plus a Minimum Closure Radius profile over 0/1/2/3 px probes, including weighted closure score, capped mean required radius, and Open@3 counts
- Safe Gap remains the conservative short-gap path; Extended Gap requires endpoint alignment plus Ridge/Color evidence along the missing path
- One-click Optimization orchestrates Global Auto Tune, local sensitivity calibration, topology evaluation, and guarded Safe/Extended Gap repair
- automatic Gap repair is accepted only when Recall/Leakage guards pass and the Minimum Closure Radius profile improves; manual Gap preview/application remains available under advanced diagnostics
- guided precision-evaluation ROI suggestions select difficult/representative regions automatically; suggestions are provisional until the user confirms every visible boundary in the ROI has been labelled
- Gap Preview classifies candidates by reason: Safe, Extended, Negative/Exclusion rejection, angle mismatch, distance excess, and score/evidence rejection
- Gap application records before/after closure snapshots, closed-region count change, and closure-rate change for diagnostic JSON export
- independent Negative validation holdout: whole Closed Negative Fill regions are split between tuning and validation so one grain interior never leaks into both sets
- deterministic Positive validation holdout using a 4×4 spatial grid and pixel-balanced cell selection to keep the validation share close to 20% even when one connected reference component is very large
- optional border-assisted Closed Negative Fill: a user-selected grain may use one image edge or two adjacent image edges as part of its closure, with area/contact safety checks and explicit seed persistence
- Partial Label evaluation: Positive / Negative / Unknown, with unlabelled predictions excluded from false-positive counts
- whole-image Positive Recall / Negative Leakage / Alignment Error metrics
- 4x4 region-balanced Macro Negative Leakage for spatially balanced Partial Label tuning
- verified complete-evaluation ROIs that report formal True Precision / Recall / F1 only where the user declares all boundaries labelled; provisional guided ROI suggestions never contribute to formal metrics until confirmed
- automatic 1 / 2 / 3 / 4 px Multi-Tolerance diagnostics
- editable rectangular exclusion regions with move, edge/corner resize, Delete, Undo and Redo
- orange non-boundary annotations for improved visibility on purple/magenta Barker images
- Auto Tune v2 search trace v4 remains available as the global tuning stage; v0.3.7 wraps it with local calibration and topology-guarded post-processing in the One-click Optimization workflow
- reference-guided 4×4 Local Calibration v2.1: verified complete-evaluation ROIs contribute true foreground/background supervision, measured zero-delta cells remain hard anchors, interpolation is limited to unmeasured adjacent cells, and regional Recall guardrails prevent aggressive local sensitivity drops
- one-click stage diagnostics record whether Global/Local tuning was accepted, produced no change, or was rolled back, including machine-readable reasons and per-cell Local candidate results
- Precision Guide v2 uses an independent 8×8 candidate grid: with no reference it deterministically selects three spatially separated bootstrap ROIs from the source fingerprint; later optimization rounds can propose 1–3 additional unverified regions using Recall, Negative Leakage, prediction excess, Local-risk and spatial-coverage signals
- the currently guided ROI is emphasized with a thicker yellow dashed frame; entering Annotation Assist or holding H temporarily hides ROI frames so the underlying grain boundary remains easy to trace, and releasing H / leaving Assist restores the frames
- one-click diagnostic ZIP export packages manifest.json, Diagnostic JSON v13, preview/comparison/feature/reference/annotation images into one dependency-free ZIP bundle; individual-file export remains available as a fallback
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
  -> Precision Guide v2: 8×8 bootstrap ROIs when no reference exists, then active additional ROI suggestions when later rounds need more evaluation coverage
  -> One-click Optimization
       -> Auto Tune v2 coordinate descent (verified ROI True F1 when available; otherwise Positive Recall + Macro Negative Leakage)
       -> reference-guided local sensitivity calibration
       -> Topology v3 Minimum Closure Radius profile
       -> Safe / Extended Gap proposals with Recall/Leakage/Topology guards
  -> advanced manual comparison / tuning / Gap diagnostics when needed
  -> evaluation history / project save
```

Full-resolution overlapping-tile analysis, stronger dendrite false-positive suppression, higher-resolution/continuous local calibration, Smart Trace, and final PNG / mask / SVG export remain planned. v0.3.9 adds Precision Guide v2 bootstrap/active ROI acquisition while keeping Local Calibration on its existing 4×4 grid; topology remains a guard for One-click Gap post-processing, while the underlying Auto Tune v2 coordinate-descent objective itself is still based on verified ROI True F1 or Partial Label metrics.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

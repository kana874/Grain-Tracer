# Changelog

## v0.3.3-alpha - 2026-09-28

### Added
- Reference Editor v2 with canonical centerline-driven rendering.
- Reference Undo / Redo buttons with Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z shortcuts.
- Up to 120 in-session reference-edit history entries using changed pixels only.
- Adjustable reference-line opacity, stored in GrainTracer project settings.
- Dirty-rectangle updates while drawing and erasing so only the affected reference area is rebuilt.

### Changed
- The visible yellow reference line is now generated from the same reference centerline and judgement-width mask used by evaluation.
- Drawing no longer uses a separate temporary vector stroke, removing the pointer-up visual shift.
- Reference opacity affects display only and does not change judgement width or evaluation.
- Clear-all reference editing is Undo-able.
- App version advanced to `0.3.3-alpha`; boundary algorithm remains `boundary-v4-dendrite`.

### Validation
- Reference Editor helper module is isolated from boundary analysis so editing changes do not alter the extraction algorithm.
- Undo / Redo history stores only changed centerline pixels rather than full preview masks.

## v0.3.2-alpha - 2026-09-28

### Added
- ChatGPT-oriented diagnostic export: diagnostic JSON, preview JPG, comparison PNG, Dark Ridge PNG, dendrite-difference PNG, and reference PNG.
- Diagnostic JSON now includes TP / FP / FN feature statistics, regional metrics, error hotspots, compact tuning history, and Macro Region F1.
- Deterministic connected-component holdout split for tuning vs. validation reference data.
- Global and local auto-tuning now use the tuning subset when enough holdout data exists and report validation F1 separately.
- Structure-Tensor dendrite orientation analysis and cross-boundary dendrite-difference feature.
- Dendrite difference is now a fourth boundary feature alongside Dark, Dark Ridge, and Lab color difference.
- Dendrite weight participates in CPU auto-tuning and local sensitivity calibration.

### Changed
- Algorithm version advanced to `boundary-v4-dendrite`.
- App version advanced to `0.3.2-alpha`.
- Diagnostic reports now expose the tuning/validation split so ChatGPT can distinguish fitting gains from generalization.

### Validation
- JavaScript syntax checks passed for the updated modules.
- Synthetic Structure-Tensor test produced a strong dendrite-difference response at an artificial orientation boundary and near-zero response within uniform-orientation regions.
- Synthetic auto-tune/holdout test confirmed that tuning and validation metrics are computed independently.

All notable GrainTracer changes are recorded here.

## [0.3.0-alpha] - 2026-09-28

### Added

- Multi-scale Dark Ridge detection at multiple line widths and four orientations.
- Direction-aware Lab colour-difference feature across the detected ridge normal.
- Local adaptive luminance normalisation for spatial illumination/colour unevenness.
- Local normalisation of Ridge and colour features.
- Separate Dark / Ridge / Color weights.
- Centerline-based reference evaluation to reduce dependence on reference brush width.
- 4×4 regional Precision / Recall / F1 metrics.
- Persistent evaluation history.
- GrainTracer project JSON save/load.
- IndexedDB autosave and automatic restore for matching BMP files.
- Lightweight source fingerprint using metadata plus sampled file regions.
- CPU auto-tuning updated for the three-feature boundary model.
- Reference-guided 4×4 local sensitivity calibration with bounded, regularised regional search.
- Smooth per-pixel interpolation of local sensitivity corrections with decay toward the global setting in unlabelled regions.
- Local calibration persistence in project JSON / IndexedDB autosave.
- Reference-line display width now exactly matches the comparison judgement band; the separate hidden tolerance width was removed from the UI.
- Comparison view now shows the exact reference judgement band faintly behind match/error colours.

### Changed

- CPU auto-tuning now uses a fast two-stage search: threshold/weight tuning in the reviewed area, then connected-component tuning on one full-image candidate.
- Reference drawing internally keeps a thin centerline for evaluation while retaining a thicker display mask.

### Validation

- JavaScript syntax checks passed for the new v0.3 modules.
- A synthetic boundary test passed for the v0.3 analysis pipeline and auto-tuning.
- Module syntax validation passed after local-calibration integration.
- Real 400 MB-class BMP behaviour still requires validation in the browser on production microscopy images.

## [0.2.0-alpha] - 2026-09-28

### Added

- Reference boundary drawing and erasing.
- Tolerant comparison overlay.
- Precision / Recall / F1 metrics.
- CPU-based parameter auto-tuning.

## [0.1.0-alpha] - 2026-09-28

### Added

- Initial browser application shell.
- Direct parsing of large uncompressed 24-bit and 32-bit BMP files.
- Low-memory preview generation.
- Image metadata display.
- Pan, zoom, fit and 100% preview controls.
- Preview-level grain-boundary candidate extraction.
- Separate boundary overlay layer.

# Changelog

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

# Changelog

## v0.3.6.2-alpha - 2026-09-29

### Added
- Middle-button drag now temporarily pans the viewer from any annotation tool without changing the selected tool.
- Diagnostic JSON v5 performance block with latest browser-session timings for feature computation, boundary analysis, comparison, Auto Tune, closed-fill rebuild, annotation commit, and autosave.
- Closed-region component-index caching so repeated fill seeds reuse the same positive-reference geometry.

### Changed
- Closed-region Negative Fill rebuild now labels the preview once and resolves all seeds against that shared connected-component index instead of flood-filling the full preview once per seed.
- The 3 px closed-fill safety dilation now uses an O(N) separable sliding-window pass and is computed once per region index.
- Tool switching no longer rebuilds the full exclusion mask only to change selection handles.
- Viewer pan transforms are coalesced with `requestAnimationFrame`.
- Autosave snapshot creation and IndexedDB writes are deferred to browser idle time after the existing debounce.
- Reference/overlay opacity sliders defer full-preview redraws until slider release.
- App version advanced to `0.3.6.2-alpha`; boundary extraction identifier remains `boundary-v4-dendrite-negref`.

### Validation
- JavaScript syntax validation passed for all source modules.
- Sliding-window safety dilation matched a brute-force dilation across multiple synthetic dimensions and radii.
- Synthetic 1800×1320 / 35-seed closed-fill test completed with one initial region-index build and a substantially faster cached rebuild; exact timing is environment dependent.
- Existing seed-based project persistence remains unchanged and compatible with v0.3.6.1 projects.

## v0.3.6.1-alpha - 2026-09-29

### Added
- Click-to-fill closed grain interiors as high-confidence non-boundary annotations using the positive reference mask as a flood-fill wall.
- Safety handling for closed fills: open regions, oversized regions, tiny regions, and clicks on the positive boundary are rejected.
- A 3 px safety band keeps generated Negative pixels away from the positive reference.
- Closed-fill seed coordinates are saved in project JSON and regenerated from the current positive reference instead of persisting the expanded fill as the source of truth.
- Undo / Redo support for closed-fill creation and combined clearing of manual/closed Negative annotations.
- 4×4 Macro Negative Leakage and Negative spatial-distribution diagnostics.
- Diagnostic JSON v4 fields for Macro Negative Leakage, negative-region count, maximum regional concentration, and closed-fill seeds.

### Changed
- Partial Label Auto Tune v2 now optimizes Positive Recall against region-balanced Macro Negative Leakage instead of only pixel-weighted Negative Leakage.
- Pixel-weighted Negative Leakage remains available as a descriptive metric.
- Closed-region Negative fills are included in Auto Tune v2 training data; seed-derived fills are not presented as an independent Negative holdout.
- App version advanced to `0.3.6.1-alpha`; boundary extraction identifier remains `boundary-v4-dendrite-negref`.

### Validation
- JavaScript syntax validation passed for analysis, app, evaluation, project, diagnostics, and closed-fill modules.
- Synthetic closed-region test accepted a fully enclosed region and rejected an open region that reached the image edge.
- Synthetic spatial-imbalance test confirmed Macro Negative Leakage differs from pixel-weighted leakage and gives equal weight to labelled regions.

## v0.3.6-alpha - 2026-09-28

### Added
- Auto Tune v2 using coarse-to-fine coordinate descent across Sensitivity, Dark, Ridge, Color, Dendrite, and MinComponent.
- Feature weights may now reach zero, allowing Dark / Ridge / Color / Dendrite to be completely disabled when they reduce tuning quality.
- Automatic ablation summary for Full, -Dark, -Ridge, -Color, and -Dendrite configurations.
- Complete-evaluation ROI aware tuning: when one or more complete ROIs exist, formal ROI True F1 becomes the primary objective.
- Partial Label fallback objective balancing Positive Recall against explicit Negative leakage when no complete ROI exists.
- Compact Auto Tune v2 search summaries are stored in evaluation history and diagnostic JSON.

### Changed
- Fixed hard-coded weight profiles were removed from global automatic tuning.
- Auto Tune no longer uses unlabelled Unknown areas as negative evidence.
- Positive/negative holdout remains active for Partial Label tuning; complete-ROI tuning uses the complete labelled ROI data instead of presenting an overlapping holdout as independent validation.
- App version advanced to `0.3.6-alpha`; boundary extraction identifier remains `boundary-v4-dendrite-negref`.

### Validation
- JavaScript syntax validation passed for the modified analysis, app, diagnostics, project, and UI modules.
- Synthetic Partial Label tuning started from a misleading Ridge-heavy configuration and converged to Ridge=0 with Positive Recall=1.0 and Negative Leakage=0.
- Synthetic complete-ROI tuning selected the complete-ROI objective and reached ROI True F1=1.0 on a controlled test image.
- Ablation output correctly reported the score change when the informative Dark feature was removed.

## v0.3.5-alpha - 2026-09-28

### Added
- Partial Label evaluation with explicit Positive, Negative, and Unknown states; predictions in unlabelled Unknown areas are no longer counted as false positives.
- Whole-image Positive Recall, Negative Leakage, and Alignment Error as the primary Partial Label metrics.
- Complete-evaluation ROI rectangles. Formal True Precision / Recall / F1 are calculated only inside ROIs that the user declares fully labelled.
- Automatic Multi-Tolerance diagnostics at 1, 2, 3, and 4 preview pixels.
- Complete-evaluation ROI project persistence and diagnostic PNG export.
- Diagnostic JSON v3 with Partial Label metrics, Unknown prediction counts, complete-ROI metrics, and Multi-Tolerance results.
- Selection handles for exclusion rectangles and complete-evaluation ROIs.
- Move, four-edge resize, four-corner resize, Delete/Backspace, Undo, and Redo for rectangle annotations.

### Changed
- Non-boundary annotation colour changed from purple to orange (`#FF8A00`) for visibility on Barker images dominated by purple/magenta.
- Existing v0.3 auto-tuning now scores only explicitly labelled Positive/Negative areas; unlabelled predictions are ignored instead of being treated as negatives.
- Whole-image Precision / Recall / F1 are no longer presented as formal evaluation metrics in Partial Label mode.
- App version advanced to `0.3.5-alpha`; extraction algorithm identifier remains `boundary-v4-dendrite-negref`.

### Validation
- JavaScript syntax validation passed for evaluation, annotation, project, diagnostics, analysis, local-tune, and app modules.
- Synthetic Partial Label test confirmed one Positive hit, one explicit Negative violation, and one Unknown prediction are separated correctly; the Unknown prediction does not increase false positives.
- Synthetic Multi-Tolerance test confirmed a boundary displaced by two preview pixels fails at 1 px and matches at 2 px.
- Synthetic complete-ROI test confirmed formal Precision / Recall / F1 calculation inside a fully labelled ROI.
- Synthetic rectangle-editor tests confirmed corner hit-testing, move, and corner resize geometry.

## v0.3.4-alpha - 2026-09-28

### Added
- Purple non-boundary reference brush for explicitly labelling intragranular lines, dendrite structures, scratches, and other false-positive examples.
- Grey rectangular exclusion tool for scale bars, text, and image regions that should not participate in extraction or evaluation.
- Non-boundary and exclusion annotations are persisted in project JSON / IndexedDB autosave.
- Non-boundary annotations participate in global and local CPU tuning as negative examples.
- Independent positive/negative holdout handling for validation when enough labelled components exist.
- Diagnostic JSON v2 fields for non-boundary hit rate, excluded-pixel coverage, annotation counts, and non-boundary feature statistics.
- Diagnostic PNG export for non-boundary and exclusion annotation layers.
- Undo / Redo support for positive lines, non-boundary lines, exclusion rectangles, and clear-all annotation operations.

### Changed
- Positive and non-boundary labels automatically remove conflicting labels along a newly drawn stroke.
- Exclusion regions are removed before connected-component analysis and ignored by Precision / Recall / F1 evaluation.
- Predictions in labelled non-boundary areas count as false positives even when outside the positive-reference review radius.
- Algorithm identifier advanced to `boundary-v4-dendrite-negref`.
- App version advanced to `0.3.4-alpha`.

### Validation
- JavaScript syntax validation passed for the updated annotation, analysis, evaluation, project, diagnostics, and UI modules.
- Synthetic evaluation confirmed that a labelled non-boundary prediction lowers Precision and that covering the same region with an exclusion rectangle removes that false-positive contribution.

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

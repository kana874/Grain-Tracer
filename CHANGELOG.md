# Changelog

## v0.3.7-alpha - 2026-10-01

### Added
- One-click Optimization as the primary tuning workflow. A single run orchestrates Global Auto Tune, local sensitivity calibration, final topology evaluation, and guarded Safe/Extended Gap repair.
- Guided precision-evaluation ROI workflow. When no verified complete ROI exists, GrainTracer proposes up to three difficult/representative regions and guides the user through labelling every visible boundary in each region.
- Provisional ROI semantics: automatically suggested ROIs are excluded from formal True Precision / Recall / F1 until the user explicitly confirms the ROI is fully labelled. Verified ROI metadata is persisted in project JSON.
- Topology v3.0 Minimum Closure Radius profile over 0/1/2/3 px probes, with weighted closure score, capped mean required radius, radius histogram, and Open@3 count.
- Automatic Gap acceptance guard. One-click Safe/Extended repairs are applied only when Positive Recall and Macro Negative Leakage remain within guard limits and the closure profile improves.
- Diagnostic JSON v11 distinguishes verified/provisional evaluation ROIs and records Topology v3 data through the normal topology/history payloads.

### Changed
- Manual Compare, Auto Tune, local tuning, Topology and Gap controls remain available but are grouped under the collapsed `詳細チューニング・診断` section.
- Auto Tune v2 and local calibration can now run as composable stages without independently owning the global busy state or producing duplicate history entries.
- Complete-ROI formal metrics and Auto Tune use only verified ROIs. Manually created complete ROIs are verified immediately; guided suggestions require explicit confirmation.
- App version advanced to `0.3.7-alpha`; algorithm identifier advanced to `boundary-v10-one-click-topology-profile`.

### Safety / behaviour
- The app never treats an automatically selected ROI as complete ground truth by itself. User confirmation is required after all visible boundaries in that rectangle have been labelled.
- Users may skip the precision-ROI guide and continue One-click Optimization with the existing Partial Label objective.
- Automatic Gap application is conservative: Recall may not fall by more than 0.1 percentage point, Macro Negative Leakage may not rise by more than 0.1 percentage point, verified-ROI F1 may not regress beyond the same tolerance, and topology must improve.
- Advanced manual controls remain available for diagnosis and intervention.

## v0.3.6.7-alpha - 2026-10-01

### Added
- Two-stage Gap Bridge workflow: the existing conservative Safe Gap path is retained and a separate Extended Gap Preview can inspect gaps beyond the Safe limit up to 8 preview pixels.
- Extended Gap requires endpoint direction consistency, minimum candidate score, Ridge/Color response along the missing path, and the existing Negative/Exclusion safety guards.
- Gap Preview reason classification and colour coding: green for Safe, yellow for Extended, red for Negative/Exclusion rejection, purple for angle mismatch, gray for distance excess, and orange for score/evidence or other rejection.
- Before/after topology snapshots for each Gap proposal, including Closure Rate and the number of newly closed regions.
- Auto Tune v2 search trace v4 records Closure diagnostics before and after tuning. Topology is diagnostic-only in this release and does not change parameter selection.
- Diagnostic JSON v10 stores Safe/Extended application history and a dedicated before/after topology difference payload.

### Changed
- Topology advanced to v2.3 (`2.3-extended-gap-closure-diagnostics`).
- Border-assisted closure now explicitly distinguishes a single allowed image edge from a two-adjacent-edge corner case. Reaching an unannotated edge, an opposite-edge pair, more than two edges, or an excessive reachable-area ratio keeps the region open.
- Gap application metadata now retains Safe and Extended bridge counts separately while preserving one-click reversion to the extraction mask before the first Gap application.
- App version advanced to `0.3.6.7-alpha`; algorithm identifier advanced to `boundary-v9-extended-gap-topology-diagnostic`.

### Safety / behaviour
- Safe Gap and Extended Gap are never applied automatically by Auto Tune or Topology diagnostics.
- Extended Gap is preview-only until the user explicitly presses the apply button.
- Negative and Exclusion constraints remain hard rejects for both stages.
- Auto Tune Closure data is reported for diagnosis only; direct topology-aware optimization remains deferred to v0.3.7.

### Validation
- Synthetic validation confirmed Extended Gap acceptance with strong path evidence, rejection across guarded Negative pixels, and open-to-closed topology change after a repaired gap.
- Synthetic Border-assisted validation confirmed that a single annotated image edge can remain virtually closed while leakage to an unannotated edge is classified as open.
- JavaScript syntax validation passed across all source modules, and all explicit app DOM references resolve against the updated HTML.

## v0.3.6.6-alpha - 2026-09-29

### Added
- Topology v2.2 Safe Gap Bridge proposal and explicit application workflow.
- Magenta Safe Gap preview overlay with configurable maximum gap distance, endpoint-angle tolerance, and minimum candidate score.
- Safety rejection for bridge segments that cross Exclusion pixels or a 1 px guard around explicit Negative labels.
- Greedy endpoint conflict protection so one endpoint is used by at most one accepted bridge; application remains user-confirmed and reversible.
- Diagnostic JSON v9 records Safe Gap settings, proposal summary, applied bridge metadata, and bridge timing.

### Changed
- Auto Tune v2 search trace advanced to v3. Fast raw scoring still proposes coordinate changes, but each changed coordinate must improve the processed post-NMS / neighbour-support / minimum-component objective before it is accepted.
- Auto Tune Ablation now uses the same processed stage as the final tuning objective, so Full and feature-disabled scores are directly comparable.
- Topology revision advanced to `2.2-safe-gap-bridge`.
- App version advanced to `0.3.6.6-alpha`; algorithm identifier advanced to `boundary-v8-safe-gap-processed-tune`.

### Safety / behaviour
- Safe Gap Bridge is never applied automatically by Auto Tune or Topology diagnostics.
- Preview candidates are limited by distance, facing angle and score, cannot cross Exclusion or guarded Negative pixels, and can be reverted to the pre-bridge extraction mask.
- Project persistence stores Safe Gap settings but not the transient extraction/bridge mask, matching existing analysis-mask behaviour.

### Validation
- Implementation keeps the existing v0.3.6.5 candidate detector and adds a stricter post-filter/application stage.
- Processed-gated coordinate tuning and processed Ablation share the same NMS / neighbour-support / component pipeline as final extraction.

## v0.3.6.5-alpha - 2026-09-29

### Added
- Continuous Ridge-normal orientation for Centerline NMS. The existing four Ridge direction responses are combined as an axial doubled-angle estimate, and boundary scores are bilinearly sampled at ±1 preview pixel along that normal.
- Spatially balanced Positive holdout. Positive reference pixels are divided by a deterministic 4×4 grid and validation cells are selected to keep the labelled validation-pixel share close to 20%.
- Border-assisted Closed Negative Fill. When explicitly enabled for a new seed, the image frame may form part of a grain-interior closure together with the yellow reference line.
- Border-assisted Fill safety checks for maximum area, maximum/adjacent frame-side usage, and minimum positive-reference contact.
- Per-seed persistence of the border-assisted flag in project JSON/autosave.
- Topology v2.1 support for border-assisted Closed Fill cores.
- Direction-consistent short-gap candidate diagnostics using endpoint distance/facing checks. Candidates are reported only; no automatic boundary bridging is performed.
- Diagnostic JSON v8 fields for continuous NMS, Positive spatial holdout, border-assisted annotations, and Topology v2.1.

### Changed
- Centerline NMS now uses continuous-angle bilinear comparisons rather than only the four sampled Ridge bins; flat plateaus retain midpoint handling.
- Positive Auto Tune/local-tune holdout uses spatial pixel balancing instead of connected-component sizing.
- Topology core erosion was corrected and now preserves the intended interior core geometry.
- App version advanced to `0.3.6.5-alpha`; extraction identifier advanced to `boundary-v7-continuous-nms-border-negref`.

### Safety / behaviour
- Existing Closed Fill seeds remain ordinary closed-loop seeds after project restore. Border-assisted behaviour is used only by seeds explicitly created with the option enabled.
- Border-assisted regions that are too large, touch opposite image sides, touch too many frame sides, or lack sufficient yellow-reference contact are rejected.
- Topology bridge probes and short-gap candidates remain diagnostic-only and do not alter the extraction mask.

### Validation
- JavaScript syntax validation and DOM-ID consistency passed after the v0.3.6.5 changes.
- Synthetic top-edge grain test: ordinary fill was rejected as open, while the same region with border-assisted mode was accepted; a large exterior region remained rejected.
- Synthetic Positive reference test produced a 20.4% validation share despite a strongly uneven connected reference.
- Synthetic continuous-angle NMS reduced a broad diagonal Ridge response substantially while retaining the centre response.
- Synthetic 3-pixel missing boundary segment produced exactly one aligned short-gap candidate.
- Border-assisted Topology v2.1 preserved an eroded high-confidence core and classified the annotated top-edge grain as closed.

## v0.3.6.4-alpha - 2026-09-29

### Added
- Optional Ridge-normal Non-Maximum Suppression (NMS) Centerline mode. Boundary candidates are thinned along the estimated boundary normal before connected-component filtering, with midpoint selection for flat response plateaus.
- Topology v2 based on eroded Closed Negative Fill core regions instead of single fill seed points.
- Topology v2 separately reports Core Closure and prediction coverage of the core so a thicker diagnostic bridge cannot masquerade as improved topology merely by covering a seed point.
- Whole-region Closed Negative Fill holdout. Valid filled grain interiors are deterministically split into tuning and validation groups, defaulting to approximately 80/20 by region count.
- Diagnostic JSON v7 fields for NMS state, Topology v2, Closed Fill holdout region/pixel counts, and independent Negative validation leakage.

### Changed
- The normal extraction pipeline now applies directional NMS before neighbour-support and minimum-component filtering when Centerline mode is enabled.
- Auto Tune v2 processed candidate acceptance and MinComponent optimisation use the same NMS-enabled extraction path as the displayed result.
- Manual Negative line holdout and Closed Fill region holdout are combined without sharing the same Closed Fill region between tuning and validation.
- Topology bridge probes remain diagnostic-only; they do not alter the displayed extraction mask.
- App version advanced to `0.3.6.4-alpha`; extraction identifier advanced to `boundary-v6-nms-edge-negref`.

### Validation
- JavaScript syntax validation passed across all source modules and all app DOM references resolve.
- Synthetic 3-pixel-wide flat boundary response is reduced by NMS to the centre pixel column, avoiding a deterministic left/right positional bias.
- Synthetic one-pixel boundary gap is open at 0 px and closed from the 1 px probe onward under Topology v2, with monotonic closure.
- Synthetic ten-region Closed Fill data split into eight tuning regions and two validation regions with zero pixel overlap.

## v0.3.6.3-alpha - 2026-09-29

### Added
- Annotation-assist view that attenuates the automatic boundary/comparison overlay and Negative annotation overlay without changing analysis or label geometry.
- `H` hold shortcut to temporarily hide the automatic overlay and inspect the source image; `V` toggles annotation-assist view.
- On-demand Topology diagnostics with an interior endpoint proxy and Seed Closure Rate probes at 0 / 1 / 2 / 3 preview-pixel bridge radii.
- Diagnostic JSON v6 topology payload and topology runtime measurement.

### Changed
- Boundary scoring is now edge-aware: near image borders, only geometrically available Dark / Ridge / Color / Dendrite channels contribute and their weights are renormalized locally.
- The outermost 1 preview pixel remains guarded to suppress image-frame artifacts, while neighbor-support filtering now handles image bounds and allows boundaries to approach that guard.
- Auto Tune v2 raw candidate scoring uses the same edge-aware feature availability rules as final extraction.
- App version advanced to `0.3.6.3-alpha`; extraction identifier advanced to `boundary-v5-edge-aware-negref`.

### Notes
- Topology diagnostics are observational only in this version. Seed Closure and endpoint proxy values do not yet affect Auto Tune v2 or automatically bridge gaps.
- Bridge-radius probes only dilate a temporary diagnostic copy of the prediction; they do not modify the displayed or saved extraction result.

### Validation
- JavaScript syntax validation passed across all source modules.
- Synthetic edge-scoring test confirmed the protected outermost pixel remains suppressed while a strong boundary cue one pixel inward can be evaluated.
- Synthetic one-pixel-gap topology test reported an open seed region at 0 px and a closed seed region at a 1 px bridge probe.
- DOM references for the annotation-assist and Topology controls resolve against the updated HTML.

## v0.3.6.2-alpha - 2026-09-29

### Added
- Middle-button drag now temporarily pans the viewer from any annotation tool without changing the selected tool.
- Diagnostic JSON v5 performance block with latest browser-session timings for feature computation, boundary analysis, comparison, Auto Tune, closed-fill rebuild, annotation commit, and autosave.
- Closed-region component-index caching so repeated fill seeds reuse the same positive-reference geometry.

### Changed
- Closed-region Negative Fill rebuild now labels the preview once and resolves all seeds against that shared connected-component index instead of flood-filling the full preview once per seed.
- The 3 px closed-fill safety dilation now uses an O(N) separable sliding-window pass and is computed once per region index.
- Tool switching and exclusion-rectangle drag previews no longer rebuild the full exclusion mask only to update selection geometry.
- Positive-reference strokes defer expensive closed-fill topology rebuilds to browser idle time; comparison/tuning/export forces a fresh rebuild when required.
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

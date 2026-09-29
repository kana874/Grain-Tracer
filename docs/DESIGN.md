# GrainTracer design

## 1. Goal

GrainTracer extracts and annotates grain boundaries from Barker-etched polarized-light aluminum micrographs while leaving the original source image unchanged.

The normal input is the original large BMP exported by the microscope/camera system. The user should not need to pre-split a 400 MB-class image.

## 2. Non-destructive model

```text
Source BMP (read only)
  + derived feature maps
  + automatic boundary candidates
  + user reference boundaries
  + user non-boundary examples
  + rectangular exclusion regions
  + complete-evaluation ROI regions
  + comparison/evaluation history
  + analysis settings
```

The current preview workflow stores reference information at preview resolution. Full-resolution geometry will use original-image coordinates when tiled analysis is implemented.

## 3. Large BMP strategy

The browser reads the BMP header and only source rows required for a reduced preview. It does not decode the complete source BMP into an RGBA canvas.

Future full-resolution extraction will use overlapping tiles, initially targeting approximately:

```text
tile: 2048 × 2048 px
halo: 64 px per side
```

## 4. v0.3 boundary model

The current preview boundary score uses four features:

```text
BoundaryScore =
  w_dark      * LocalDarkness
+ w_ridge     * MultiScaleDarkRidge
+ w_color     * DirectionalLabDifference
+ w_dendrite  * DendriteDifference
```

The dendrite feature is based on local Structure-Tensor orientation/coherence and compares tissue-like orientation changes across a candidate boundary.

### Local darkness

Brightness is evaluated relative to a local neighbourhood as well as by absolute darkness. This reduces sensitivity to uneven illumination and Barker colour variation across the field.

### Multi-scale Dark Ridge

Ridge response is evaluated at several scales and four orientations. The normal-direction dark-line response is penalised by the tangent-direction response. Dot-like dark structures therefore tend to score lower than elongated grain-boundary lines.

### Directional Lab difference

The ridge detector supplies an estimated boundary normal. Colour samples are taken on both sides of that normal at several distances and compared in Lab space.

### Local adaptive normalisation

Local adaptation can be enabled/disabled and has adjustable strength/window size. Ridge and colour features are normalised against their local neighbourhood so that one global absolute threshold is not the only criterion across a spatially uneven image.

## 5. Partial Label evaluation

The visible positive reference stroke can be thick for usability, but evaluation uses a separate thin centerline.

The normal whole-image evaluation model is three-state:

- Positive: user-labelled grain boundary.
- Negative: user-labelled non-boundary.
- Unknown: unlabelled image area.

Unknown is not equivalent to Negative. Automatic boundary pixels in Unknown areas are reported as unknown predictions and are not counted as false positives.

The primary Partial Label metrics are:

- Macro Negative Leakage: unweighted mean Negative Leakage across 4×4 regions containing explicit Negative labels; this prevents a densely-labelled region from dominating tuning.
- Positive Recall: fraction of positive reference-centerline pixels matched within the spatial tolerance.
- Negative Leakage: fraction of explicit negative-mask pixels containing an automatic prediction.
- Alignment Error: preview-pixel distance from positive reference centerline to the nearest prediction.

Multi-Tolerance diagnostics automatically recalculate labelled performance at 1, 2, 3, and 4 preview pixels to distinguish positional offset from a missing boundary.

Formal Precision / Recall / F1 are calculated only inside complete-evaluation ROIs. A complete-evaluation ROI is a rectangle where the user declares that every grain boundary has been labelled; therefore unlabelled pixels inside that ROI can legitimately act as negative background.

Regional Partial Label metrics are calculated on a 4×4 grid and stored with diagnostic/evaluation data.

## 6. Auto Tune v2

GPU use is not required.

v0.3.6 replaces the fixed weight-profile search with CPU coordinate descent over:

```text
Sensitivity
Dark
Ridge
Color
Dendrite
MinComponent
```

Each feature weight may reach `0`, so a feature that is harmful on the current image can be disabled rather than being forced to retain a minimum contribution.

The coordinate order is:

```text
Sensitivity
-> Dark
-> Ridge
-> Color
-> Dendrite
-> MinComponent
-> repeat with finer steps
```

The search uses coarse-to-fine steps over up to three rounds. Weight/sensitivity candidates are scored on labelled data without allocating a full preview mask for every candidate; MinComponent is then optimised on the processed full-preview mask.

Objective selection follows the v0.3.5 evaluation model:

- when complete-evaluation ROIs exist, formal ROI True F1 is the primary tuning objective;
- otherwise the tuner uses a Partial Label balance of Positive Recall and 4×4 Macro Negative Leakage, while Unknown pixels remain outside false-positive scoring.

The tuner records an ablation summary for:

```text
Full
-Dark
-Ridge
-Color
-Dendrite
```

The full search summary is compacted before project/history persistence so repeated Auto Tune runs do not excessively inflate project JSON.

## 7. Reference-guided local calibration

After the global parameters are tuned, GrainTracer can optimise sensitivity independently in a 4×4 grid using only regions that contain enough user reference-centerline pixels.

Each measured region searches a bounded sensitivity delta around the global setting. The local objective uses boundary F1 with a penalty for large deviations, so a tiny F1 gain cannot justify an extreme local threshold.

The measured corrections are spatially smoothed and interpolated per pixel. Unlabelled regions include a zero-correction prior, so one annotated corner does not impose the same correction across the whole image.

The local calibration grid is saved in the project and evaluation history. Changing extraction parameters or editing reference lines invalidates the old calibration.

## 8. v0.3.5 annotation model

Three annotation classes are kept separate from the source image:

- positive grain-boundary reference: yellow centerline expanded to the visible/judgement width;
- non-boundary reference: orange (`#FF8A00`) centerline expanded to the same width and used as an explicit negative example during comparison and tuning;
- exclusion rectangles: grey regions removed from extraction and evaluation, intended for scale bars, labels, and other content that should never participate in analysis;
- complete-evaluation ROIs: blue rectangles declaring local areas where all grain boundaries have been labelled, enabling formal Precision / Recall / F1.

Positive and non-boundary labels are mutually exclusive while drawing: painting one class removes conflicting centerline pixels from the other class along the same stroke.

A closed-region Negative Fill tool can convert the interior of a fully closed positive reference loop into high-confidence Negative training data. The user explicitly clicks the intended interior. Flood fill is rejected if it reaches the image edge or exceeds the safety area limit. Filled pixels keep a 3 px safety distance from the positive reference, and Positive always overrides Negative. Project persistence stores seed coordinates rather than the expanded fill mask; fills are regenerated when the positive reference changes or a project is restored.

v0.3.6.2 indexes connected non-reference regions once for the current positive-reference geometry. Multiple closed-fill seeds are resolved against that shared index and the 3 px safety dilation is also computed once. The index is invalidated only when positive-reference geometry changes. This replaces the earlier seed-by-seed full-preview flood-fill rebuild.

Viewer navigation is independent of the active annotation tool: left-button input keeps the selected tool semantics, while middle-button drag is always a temporary pan gesture. Panning transforms are coalesced through `requestAnimationFrame`.

Non-boundary examples extend the evaluated area without treating every unlabelled pixel as negative. Exclusion rectangles are also applied before connected-component evaluation so ignored image content cannot support a retained candidate component.

Undo/Redo covers positive/negative line edits, exclusion-region edits, and complete-evaluation ROI edits. Exclusion and ROI rectangles can be selected, moved, resized from all four sides/corners, and deleted after creation or project reload.

## 9. Performance and responsiveness

v0.3.6.2 moves debounced autosave snapshot/write work to browser idle time when `requestIdleCallback` is available, with a timeout fallback. Tool switching no longer rebuilds the full exclusion mask, and opacity sliders defer expensive preview redraws until release. Diagnostic JSON v5 records the latest browser-session timings for feature computation, boundary analysis, comparison, Auto Tune, closed-fill rebuild, annotation commit, and autosave.

## 9. Persistence

A `.graintracer.json` project stores:

- source-image identity/fingerprint
- preview metadata
- extraction settings
- local-adaptation settings
- comparison settings
- reference display mask and centerline
- non-boundary display mask and centerline
- closed-region Negative Fill seed coordinates
- exclusion rectangles
- complete-evaluation ROI rectangles
- evaluation history, including Partial Label and regional metrics
- reference-guided local sensitivity-calibration grid

The 400 MB-class BMP itself is not embedded.

IndexedDB is used for optional autosave and automatic restore when the same BMP fingerprint is opened again.

## 10. Next stages

- Extend local optimisation from sensitivity to selected Dark/Ridge/Color weights.
- Local F1 / compensation-map visualisation.
- Full-resolution overlapping-tile analysis and seam handling.
- Smart Trace and manual correction workflow.
- PNG / binary mask / SVG export.
- Closed-grain segmentation and grain metrics.

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

## 5. Reference evaluation

The visible reference stroke can be thick for usability, but evaluation uses a separate thin centerline.

Prediction and reference matching use a configurable spatial tolerance. Precision and Recall use separate denominators:

- Precision: matched predicted boundary pixels / predicted pixels in the reviewed zone.
- Recall: matched reference-centerline pixels / all reference-centerline pixels.

Regional metrics are currently calculated on a 4×4 grid and stored with each evaluation-history entry.

## 6. CPU auto-tuning

GPU use is not required.

Auto-tuning is deliberately split into two stages for company-PC performance:

1. sensitivity and Dark/Ridge/Color/Dendrite weight profiles are scored only in the user-reviewed area, including explicit non-boundary examples;
2. the best raw configuration is built once over the preview, then minimum connected-component size is tuned.

## 7. Reference-guided local calibration

After the global parameters are tuned, GrainTracer can optimise sensitivity independently in a 4×4 grid using only regions that contain enough user reference-centerline pixels.

Each measured region searches a bounded sensitivity delta around the global setting. The local objective uses boundary F1 with a penalty for large deviations, so a tiny F1 gain cannot justify an extreme local threshold.

The measured corrections are spatially smoothed and interpolated per pixel. Unlabelled regions include a zero-correction prior, so one annotated corner does not impose the same correction across the whole image.

The local calibration grid is saved in the project and evaluation history. Changing extraction parameters or editing reference lines invalidates the old calibration.

## 8. v0.3.4 annotation model

Three annotation classes are kept separate from the source image:

- positive grain-boundary reference: yellow centerline expanded to the visible/judgement width;
- non-boundary reference: purple centerline expanded to the same width and used as an explicit negative example during comparison and tuning;
- exclusion rectangles: grey regions removed from extraction and evaluation, intended for scale bars, labels, and other content that should never participate in analysis.

Positive and non-boundary labels are mutually exclusive while drawing: painting one class removes conflicting centerline pixels from the other class along the same stroke.

Non-boundary examples extend the evaluated area without treating every unlabelled pixel as negative. Exclusion rectangles are also applied before connected-component evaluation so ignored image content cannot support a retained candidate component.

Undo/Redo covers positive/negative line edits and exclusion-region edits.

## 9. Persistence

A `.graintracer.json` project stores:

- source-image identity/fingerprint
- preview metadata
- extraction settings
- local-adaptation settings
- comparison settings
- reference display mask and centerline
- non-boundary display mask and centerline
- exclusion rectangles
- evaluation history, including global and regional metrics
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

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

The v0.3 boundary score uses three features:

```text
BoundaryScore =
  w_dark  * LocalDarkness
+ w_ridge * MultiScaleDarkRidge
+ w_color * DirectionalLabDifference
```

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

1. sensitivity and Dark/Ridge/Color weight profiles are scored only in the user-reviewed area;
2. the best raw configuration is built once over the preview, then minimum connected-component size is tuned.

## 7. Persistence

A `.graintracer.json` project stores:

- source-image identity/fingerprint
- preview metadata
- extraction settings
- local-adaptation settings
- comparison settings
- reference display mask and centerline
- evaluation history, including global and regional metrics

The 400 MB-class BMP itself is not embedded.

IndexedDB is used for optional autosave and automatic restore when the same BMP fingerprint is opened again.

## 8. Next stages

- Reference-guided local parameter optimisation.
- Local F1 / compensation-map visualisation.
- Full-resolution overlapping-tile analysis and seam handling.
- Smart Trace and manual correction workflow.
- PNG / binary mask / SVG export.
- Closed-grain segmentation and grain metrics.

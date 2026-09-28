# GrainTracer design

## 1. Goal

GrainTracer is intended to extract and annotate grain boundaries from Barker-etched, polarized-light aluminum micrographs while preserving the original source image unchanged.

The normal user input is the original, non-split BMP exported by the microscope/camera system. Large source files (for example 400+ MB BMPs) must not require the user to pre-split the image.

## 2. Non-destructive data model

The source microscopy image is immutable. Derived information is stored separately:

```text
Source BMP (read only)
  + automatic boundary candidates
  + accepted boundary geometry
  + manual additions / deletions
  + scale calibration
  + analysis settings
```

All geometry uses original-image pixel coordinates.

## 3. Large BMP strategy

### v0.1 alpha

The browser reads only:

1. the BMP/DIB header;
2. source rows needed to build a reduced preview.

The full BMP is not decoded into an RGBA canvas. A 24-bit 400 MB BMP would otherwise require even more memory after RGBA expansion.

Supported initially:

- 24-bit BI_RGB BMP
- 32-bit BI_RGB BMP

### Full-resolution analysis target

Full-resolution extraction will operate in overlapping tiles:

```text
nominal tile: 2048 x 2048 px
overlap/halo: 64 px per side
```

Only the non-overlap core is committed to the global result. This reduces seams at tile boundaries.

## 4. Boundary detection model

Barker micrographs contain three visually competing dark structures:

- true grain boundaries;
- small dark dot-like features;
- short intragranular linear features.

Therefore plain thresholding or Canny alone is not sufficient.

The intended boundary score combines multiple cues:

```text
BoundaryScore = w_dark * dark-line evidence
              + w_color * across-boundary colour difference
              + w_cont * line continuity / topology
```

The preview implementation starts with dark-line and colour-difference cues, followed by connected-component filtering. Later OpenCV.js stages will add morphology, thinning/skeletonization, gap closing and watershed-assisted region reasoning.

## 5. User correction workflow

Automatic extraction is assistive rather than authoritative.

Planned correction tools:

- eraser for false positives;
- pen/polyline for missing boundaries;
- Smart Trace: click two endpoints and find the lowest-cost path through the boundary-likelihood map;
- undo / redo;
- per-boundary accept/reject.

## 6. Rendering layers

```text
Layer 4: manual edits
Layer 3: accepted/final boundaries
Layer 2: automatic candidates
Layer 1: immutable source image
```

The current alpha uses two HTML canvases (image + overlay). Konva.js is planned when editable vector geometry is introduced.

## 7. Planned exports

- annotated PNG
- binary boundary mask PNG
- SVG boundary geometry
- GrainTracer project JSON

Future analysis exports may include grain area, equivalent circle diameter and grain-size distributions after closed-grain segmentation is sufficiently reliable.

## 8. Version plan

| Version | Scope |
|---|---|
| v0.1 | Direct BMP load, low-memory preview, preview candidate extraction |
| v0.2 | Manual correction, undo/redo, Smart Trace |
| v0.3 | Full-resolution tiled processing and seam handling |
| v0.4 | PNG / mask / SVG / project export |
| v0.5 | Scale calibration and closed-grain recognition |
| v0.6 | Grain metrics and distributions |
| v1.0 | Validated stable workflow |

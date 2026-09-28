# GrainTracer

GrainTracer is a browser-based grain-boundary extraction and annotation tool for Barker-etched polarized aluminum micrographs.

## Current status

**v0.1.0-alpha — implementation started**

The first implementation focuses on:

- opening very large, uncompressed BMP files directly in the browser
- parsing BMP metadata without decoding the whole image at once
- generating a downsampled preview by reading only sampled source rows
- preview-level grain-boundary candidate extraction
- keeping the source image unchanged and drawing results on a separate overlay layer

The intended workflow is:

```text
Original BMP
  -> lightweight preview
  -> boundary candidate extraction
  -> manual correction
  -> full-resolution tiled analysis
  -> overlay / mask / SVG / project export
```

## Supported BMP input in v0.1 alpha

- Windows BMP / DIB
- 24-bit BGR, uncompressed (BI_RGB)
- 32-bit BGRA, uncompressed (BI_RGB)

Other formats and compressed BMP variants will be added later.

## Run locally

No build step is required.

Serve the repository with any local HTTP server, for example:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

## Design principles

1. The original microscopy image is never modified.
2. Boundary information is stored and rendered as a separate layer.
3. Large images are processed in tiles rather than fully expanded in memory.
4. Automatic extraction is assistive; manual correction remains part of the workflow.
5. Analysis coordinates are always expressed in original-image pixel coordinates.

See [docs/DESIGN.md](docs/DESIGN.md) for the current architecture.

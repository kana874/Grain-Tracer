# Changelog

All notable GrainTracer changes will be recorded here.

## [0.1.0-alpha] - 2026-09-28

### Added

- Initial browser application shell.
- Direct parsing of large uncompressed 24-bit and 32-bit BMP files.
- Low-memory preview generation that samples source BMP rows instead of expanding the entire image.
- Image metadata display.
- Pan, zoom, fit and 100% preview controls.
- Preview-level grain-boundary candidate extraction.
- Separate cyan boundary overlay so source pixels remain unchanged.
- Controls for extraction sensitivity, dark-line weighting, colour-difference weighting and minimum connected-component size.
- Architecture/design document for tiled full-resolution processing.
- Windows launcher for local use.

### Validation performed

- JavaScript syntax checks passed for the initial source modules.
- BMP header parsing and preview decoding were tested with a generated 24-bit bottom-up BMP.

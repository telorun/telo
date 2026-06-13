# @telorun/image

## 0.2.0

### Minor Changes

- 69220c8: New `std/image` module. `Image.Overlay` draws labelled rectangles onto an
  image (`@napi-rs/canvas`) and returns annotated bytes plus dimensions — the
  visualization half of vision-grounding loops: shapes are drawn as given and
  clipped at the image edges rather than rejected, in the same pixel top-left
  coordinate space `Pdf.Rasterizer` reports; stroke and label styling are
  resource config, the image and shape list per-invocation inputs.
  `Image.Blank` produces a solid-color canvas — a pipeline seed or hermetic
  test fixture — rejecting unrecognized CSS colors instead of letting the
  canvas silently keep its previous fill. Both kinds encode to a configurable
  `format` (png/jpeg/webp, png default) with `quality` for the lossy formats,
  and report the output's `mediaType`.

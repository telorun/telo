/**
 * Image primitives over `@napi-rs/canvas`. `Image.Fit` scales an image down to
 * fit a box and re-encodes it, judging its size from the header before any
 * decode. `Image.Overlay` draws labelled rectangles onto an image, the
 * visualization half of vision-grounding loops: render, let a model propose
 * boxes, draw them, look again. Coordinates are pixels, top-left origin.
 */

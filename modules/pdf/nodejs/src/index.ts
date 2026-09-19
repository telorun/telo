/**
 * PDF primitives — `Pdf.Rasterizer` renders a page to PNG bytes (pdf.js on a
 * server-side canvas); `Pdf.FormFields` authors editable AcroForm fields at
 * coordinates measured on that rendered image (pdf-lib). Both speak one
 * coordinate space: rendered-image pixels, top-left origin, at the configured
 * render scale.
 */

export * as rasterizer from "./rasterizer-controller.js";
export * as text from "./text-controller.js";
export * as formFields from "./form-fields-controller.js";

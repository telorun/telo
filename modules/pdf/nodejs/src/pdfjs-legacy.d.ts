// pdfjs-dist ships types only for its root entry; the legacy (Node) build is
// the same API surface.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}

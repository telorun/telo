// pdfmake ships no types for its self-contained build, which is the entry this
// module bundles (its Node entry reads standard-font metrics from a sibling
// directory, which does not survive bundling). Only what this controller calls.
declare module "pdfmake/build/pdfmake.js" {
  interface CreatedPdf {
    getBuffer(): Promise<Buffer>;
  }
  const pdfMake: {
    fonts: Record<string, Record<string, string>>;
    addVirtualFileSystem(vfs: Record<string, Uint8Array | string>): void;
    createPdf(definition: Record<string, unknown>): CreatedPdf;
  };
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts.js" {
  const vfs: Record<string, string>;
  export default vfs;
}

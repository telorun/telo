/// <reference types="vite/client" />

/** Where the telo engine studio ships is served, relative to the app's base
 *  URL — a name derived from the file's content (`vite-bundled-engine.ts`). */
declare module "virtual:telo-bundled-engine" {
  const engineFile: string;
  export default engineFile;
}

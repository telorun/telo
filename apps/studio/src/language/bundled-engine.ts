import type { BundledEngine } from "@telorun/language-host";
import engineFile from "virtual:telo-bundled-engine";

/** The engine studio ships: `@telorun/language-server`'s built file, served as
 *  a static asset of the app (see `vite-bundled-engine.ts`). Its version is
 *  what it reports in its handshake. */
export function bundledEngine(): BundledEngine {
  const url = `${import.meta.env.BASE_URL}${engineFile}`;
  return {
    load: async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`the bundled telo engine could not be loaded from ${url}: HTTP ${response.status} ${response.statusText}.`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

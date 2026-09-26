import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalSetupContext } from "vitest/node";
// @ts-expect-error — a plain ESM build script with no declarations.
import { bundleEngine } from "../scripts/build.mjs";

/** The tests drive the engine as hosts load it: the bundled, self-contained
 *  module, built fresh from the current sources. */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "telo-language-server-"));
  const bundle = join(dir, "language-server.mjs");
  await bundleEngine(bundle);
  provide("engineBundle", bundle);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    engineBundle: string;
  }
}

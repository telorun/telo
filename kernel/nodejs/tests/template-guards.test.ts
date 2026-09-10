import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * The kernel halves of the template-body rules. Each fixture is a LIBRARY
 * carrying the defect, consumed by an application that declares none of the
 * library's aliases: load-time analysis is entry-scoped, so what these assert
 * is that the kernel refuses the same shape the analyzer refuses at the
 * library, in its own words — and that a body written in the one accepted
 * spelling resolves in the defining module's scope, whatever the consumer
 * imports.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, "__fixtures__/template-guards", name, "telo.yaml");

function makeKernel(): Kernel {
  return new Kernel({ sources: [new LocalFileSource()], env: {} });
}

describe("template body guards at the kernel", () => {
  it("READS a body entry named by an expression, and its legacy dispatch form", async () => {
    // Both spellings are in artifacts that are already published — `crud@0.14.2`
    // carries `mount: api` and four `!cel "self.name + '-…'"` entry names — and
    // the runtime must read artifacts published years ago. Refusing them made
    // every app pinning such a version fail at boot, with `telo check` silent
    // because a dependency's body is entry-scoped. The push to the one
    // decidable spelling is the analyzer's, as a deprecation.
    const kernel = makeKernel();
    await kernel.load(fixture("dynamic-name"));
    await kernel.boot();
    try {
      expect(await kernel.invoke("Lib.Op.op", {})).toBe("ok");
    } finally {
      await kernel.teardown();
    }
  });

  it("READS the `{ kind, name }` object form at a dispatch slot", async () => {
    const kernel = makeKernel();
    await kernel.load(fixture("object-dispatch"));
    await kernel.boot();
    try {
      expect(await kernel.invoke("Lib.Op.op", {})).toBe("ok");
    } finally {
      await kernel.teardown();
    }
  });

  it("refuses `base:` beside a template body", async () => {
    const kernel = makeKernel();
    await kernel.load(fixture("base-with-body"));
    await expect(kernel.boot()).rejects.toThrow(
      /'base:' maps this kind's config onto the inherited controller of 'Http\.Client'/,
    );
  });

  it("injects a template child's ref slots in the defining module's alias scope", async () => {
    const kernel = makeKernel();
    await kernel.load(fixture("child-alias-scope"));
    await kernel.boot();
    try {
      // The request reaches the wire only if its `client:` slot was injected
      // with the live, credentialed client. Before the module stamp, injection
      // looked the child's kind up through the consumer's aliases, found no
      // field map, and left the slot a raw reference — reported as a client
      // "not initialized at this site". The host does not exist, so the call
      // fails; what matters is WHERE.
      await expect(kernel.invoke("Lib.Op.op", {})).rejects.toThrow();
      const error = await kernel.invoke("Lib.Op.op", {}).catch((e: unknown) => e as Error);
      expect(error.message).not.toMatch(/did not resolve|not initialized|credential/);
    } finally {
      await kernel.teardown();
    }
  });
});

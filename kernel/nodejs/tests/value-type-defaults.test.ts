import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/** A schema `default:` at a slot whose value type is held as an instance is read as
 *  the same literal written at the field is: decoded, and held to the slot's type
 *  arguments. */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (file: string) => path.resolve(here, "__fixtures__/value-type-defaults", file);

async function boot(file: string): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(fixture(file));
  await kernel.boot();
  return kernel;
}

describe("a value-type default", () => {
  it("creates a resource that leaves it out, its template body reading the decoded value", async () => {
    const kernel = await boot("telo.yaml");
    try {
      expect(await kernel.invoke("ValueTypeDefaults.Probe.probe", {})).toEqual({
        host: "advisories.acme.test",
        timeout: "5s",
      });
    } finally {
      await kernel.teardown();
    }
  });

  it("binds a call that leaves a contract input out with the decoded value", async () => {
    const kernel = await boot("telo.yaml");
    try {
      expect(await kernel.invoke("Telo.Sequence.mirrorOf", {})).toEqual({ host: "mirror.acme.test", wait: "0.25s" });
    } finally {
      await kernel.teardown();
    }
  });

  it("is refused under the type's own code when the slot's arguments refuse it", async () => {
    const error = await boot("refused.yaml").then(
      () => undefined,
      (err: { code?: string; message: string }) => err,
    );
    expect(error?.code).toBe("ERR_RESOURCE_INITIALIZATION_FAILED");
    expect(error?.message).toContain(
      "RefusedValueTypeDefault.Probe/probe: /endpoint is not a Telo.Url: its scheme must be one of http, https [ERR_URL_INVALID]",
    );
  });
});

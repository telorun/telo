import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "__fixtures__/runtime-eval-without-invoke/telo.yaml");

describe("x-telo-eval: runtime on a kind with no invoke()", () => {
  // Runtime paths are expanded against a call's inputs, so they need a call.
  // The kernel used to reach for `instance.invoke!` unconditionally and fail as
  // `undefined is not an object (evaluating 'instance.invoke.bind')` — a
  // TypeError against the kernel's own source, naming neither the kind nor the
  // annotated field. Nothing is silently skipped instead: the annotation would
  // otherwise leave the value an unevaluated expression for the resource's life.
  it("reports the kind and the annotated path instead of dereferencing the absent method", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(FIXTURE);
    await expect(kernel.boot()).rejects.toThrow(
      /declares 'x-telo-eval: runtime' \(at tag\), but its resources have no invoke\(\)/,
    );
  });
});

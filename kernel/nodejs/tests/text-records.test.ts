import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { declarationOfInstance } from "../src/instance-declaration.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * The `Text` record a controller receives: the text as written, its context, the
 * language of the module that wrote it — through a `base:` mapping and a template
 * body to the consumer that forwarded it, to the library for its own literal —
 * and whether an expression produced it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const probe = () =>
  (
    globalThis as unknown as {
      __textRecordProbe: { labels: Record<string, unknown>; peers: Record<string, boolean>; calls: unknown[] };
    }
  ).__textRecordProbe;

describe("a text a controller receives", () => {
  it("is a record attributed to the module that wrote it", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(path.resolve(here, "__fixtures__/text-records/telo.yaml"));
    await kernel.boot();

    expect(probe().labels).toEqual({
      direct: { text: "Open", context: "verb", lang: "en", computed: false },
      computed: { text: "Hello there", context: null, lang: "en", computed: true },
      files: {
        text: { plural: "n", cases: { one: "{$n} file", other: "{$n} files" } },
        context: null,
        lang: "en",
        computed: false,
      },
      fixed: {
        text: { plural: "n", cases: { few: "{$n} pliki", many: "{$n} plików", other: "{$n} pliku" } },
        context: null,
        lang: "pl",
        computed: false,
      },
      forwarded: { text: "Welcome", context: null, lang: "en", computed: false },
    });
    expect(probe().calls).toEqual([{ text: "Rate for {$who}", context: null, lang: "en", computed: false }]);

    // The controller's copy holds the reference the declaration was injected
    // with, and the declaration keeps the text as written.
    expect(probe().peers).toEqual({ direct: true });
    const root = (kernel as unknown as { rootContext: any }).rootContext;
    expect(declarationOfInstance(root.resourceInstances.get("direct").instance)?.text).toEqual({
      text: "Open",
      context: "verb",
    });
    await kernel.teardown();
  });
});

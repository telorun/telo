import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A text a controller's own evaluation produces is settled as creation settles
 * one: judged in the language of the module that wrote it and handed over as its
 * record, and the values the same evaluation produces for it judged.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

async function bootFixture() {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(path.resolve(here, "__fixtures__/late-texts/telo.yaml"));
  await kernel.boot();
  const root = (kernel as unknown as { rootContext: any }).rootContext;
  const invoke = (name: string, inputs: Record<string, unknown>) =>
    root.resourceInstances.get(name).instance.invoke(inputs);
  return { kernel, invoke };
}

describe("a text a controller evaluates", () => {
  it("is a computed record in its writer's language, and a literal arrives as settled at creation", async () => {
    const { kernel, invoke } = await bootFixture();
    expect(await invoke("notice", { who: "Ala" })).toEqual({
      title: { text: "Hello there", context: null, lang: "en", computed: true },
      banner: { heading: { text: "Hi Ala", context: "greeting", lang: "en", computed: true } },
      fixed: { text: "Welcome", context: null, lang: "en", computed: false },
    });
    await kernel.teardown();
  });

  it("refuses values the same evaluation produces that its text cannot take", async () => {
    const { kernel, invoke } = await bootFixture();
    await expect(invoke("unbound", {})).rejects.toMatchObject({
      code: "ERR_MESSAGE_PLACEHOLDER_UNBOUND",
      message: expect.stringContaining("the values for the text at 'title' at 'values' is refused: no value is given for n"),
    });
    await kernel.teardown();
  });
});

describe("a kind typing an accessor field's value as text", () => {
  it("is refused when it is registered", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Column", module: "Grid" },
        capability: "Telo.Provider",
        schema: {
          type: "object",
          properties: {
            label: { "x-telo-fragment": "Text", "x-telo-eval": "accessor" },
          },
        },
      } as any),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_TEXT_SLOT_ACCESSOR",
        message: expect.stringContaining(
          "Telo.Definition 'Column' declares 'schema.properties.label.x-telo-eval: accessor'",
        ),
      }),
    );
  });
});

describe("a kind declaring the values a text is formatted with", () => {
  it("is refused when it is registered with the declaration on a node holding no text", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Counter", module: "Grid" },
        capability: "Telo.Provider",
        schema: {
          type: "object",
          properties: { count: { type: "integer", "x-telo-text-values": {} } },
        },
      } as any),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_TEXT_VALUES_INVALID",
        message: expect.stringContaining("'Counter' declares 'schema.properties.count.x-telo-text-values' on a node that is no text"),
      }),
    );
  });
});

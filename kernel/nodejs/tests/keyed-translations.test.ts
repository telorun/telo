import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { refuseKeyedTexts, refuseMisplacedTextKeys } from "../src/keyed-translations.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const kindNamed = (name: string, schema: Record<string, unknown>) => ({
  kind: "Telo.Definition",
  metadata: { name, module: "Kinds" },
  capability: "Telo.Provider",
  schema,
});

describe("a kind naming the keyed sets it shows", () => {
  it("is refused when it is registered with the annotation below its root, or naming a by-text kind", () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    expect(() =>
      kernel.registerResourceDefinition(
        kindNamed("Nested", {
          type: "object",
          properties: { label: { type: "string", "x-telo-text-keys": ["Telo.TextTranslations"] } },
        }) as never,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_TEXT_KEYS_INVALID",
        message: expect.stringContaining("'schema.properties.label.x-telo-text-keys' below the schema's root"),
      }),
    );
    expect(() =>
      kernel.registerResourceDefinition(
        kindNamed("ByText", { type: "object", "x-telo-text-keys": ["Telo.TextTranslations"] }) as never,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_TEXT_KEYS_INVALID",
        message: expect.stringContaining("naming 'Telo.TextTranslations', which translates no keyed set"),
      }),
    );
  });
});

describe("keyed texts at creation", () => {
  it("refuses a resource naming keyed sets outside a kind's schema root", () => {
    const shape = {
      kind: "Telo.JsonSchema",
      metadata: { name: "Shape" },
      schema: { type: "object", "x-telo-text-keys": ["Self.Translations"] },
    } as unknown as ResourceManifest;
    expect(() => refuseMisplacedTextKeys(shape)).toThrow(
      expect.objectContaining({
        code: "ERR_TEXT_KEYS_INVALID",
        message: expect.stringContaining("Telo.JsonSchema 'Shape' declares 'schema.x-telo-text-keys' where nothing reads it"),
      }),
    );
  });

  it("refuses a declaration in a module with no lang: and a plural case its catalog's language lacks", () => {
    const declaration = {
      kind: "Telo.KeyedTranslations",
      metadata: { name: "Translations" },
      keys: { save: "Save" },
    } as unknown as ResourceManifest;
    expect(() => refuseKeyedTexts(declaration, "Telo.KeyedTranslations/Translations", null, false)).toThrow(
      expect.objectContaining({ code: "ERR_MESSAGE_SOURCE_LANGUAGE_MISSING" }),
    );
    const catalog = {
      kind: "Lib.Translations",
      metadata: { name: "english" },
      lang: "en",
      messages: { files: { plural: "n", cases: { few: "{$n} files", other: "{$n} files" } } },
    } as unknown as ResourceManifest;
    expect(() => refuseKeyedTexts(catalog, "Lib.Translations/english", "en", true)).toThrow(
      expect.objectContaining({
        code: "ERR_MESSAGE_PLURAL_CATEGORY_INVALID",
        message: expect.stringContaining("Lib.Translations/english: the translation at 'messages.files"),
      }),
    );
  });
});

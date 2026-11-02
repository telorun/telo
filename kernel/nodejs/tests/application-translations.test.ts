import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { TextRecord } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { TranslationSet } from "../src/application-translations.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

const text = (source: string, context: string | null = null, lang = "en"): TextRecord => ({
  text: source,
  context,
  lang,
  computed: false,
});

const catalog = (lang: string, texts: Array<Record<string, unknown>>) => ({
  lang,
  configuration: { lang, texts },
});

describe("the layered translation set", () => {
  const set = new TranslationSet("en", [
    catalog("pl", [
      { text: "Save", translation: "Zachowaj" },
      { text: "Save", context: "button", translation: "Zapisz plik" },
      { text: "Invoice { $n }", translation: "Faktura {$n}" },
    ]),
    catalog("PL", [{ text: "Save", translation: "Zapisz" }]),
    catalog("de", [{ text: "Save", translation: "Speichern" }]),
  ]);

  it("serves the fallback and every catalog's language once, compared case-insensitively", () => {
    expect(set.languages).toEqual(["en", "pl", "de"]);
  });

  it("lets a later catalog's translation of a text and context replace an earlier one's", () => {
    expect(set.translate("pl", text("Save"))).toEqual({ text: "Zapisz", context: null, lang: "pl", computed: false });
    expect(set.translate("pl", text("Save", "button")).text).toBe("Zapisz plik");
  });

  it("matches a text by the message core's identity", () => {
    expect(set.translate("pl", text("Invoice {$n}")).text).toBe("Faktura {$n}");
  });

  it("answers the text itself where nothing translates it, and never looks up a computed one", () => {
    const untranslated = text("Cancel");
    expect(set.translate("pl", untranslated)).toBe(untranslated);
    const computed = { ...text("Save"), computed: true };
    expect(set.translate("pl", computed)).toBe(computed);
  });

  it("negotiates by RFC 4647 lookup, skipping malformed and unserved entries, landing on the fallback", () => {
    expect(set.negotiate(["pl-PL"])).toBe("pl");
    expect(set.negotiate(["not a tag", "fr", "DE-at"])).toBe("de");
    expect(set.negotiate(["fr"])).toBe("en");
    expect(set.negotiate([])).toBe("en");
  });

  it("translates into the negotiated language, so an unserved one shows the fallback", () => {
    expect(set.translate("de-AT", text("Save")).text).toBe("Speichern");
    expect(set.translate("fr", text("Save")).text).toBe("Save");
  });
});

describe("the application's translations at load", () => {
  const library = (name: string, lifecycle: string, translation: string) =>
    `kind: Telo.Library
metadata: { name: ${name}, version: 1.0.0 }
lang: en
lifecycle: ${lifecycle}
exports:
  resources: [polish]
---
kind: Telo.TextTranslations
metadata: { name: polish }
lang: pl
texts:
  - { text: "Library {$n}", translation: "${translation} {$n}" }
  - { text: "Save", translation: "${translation}" }
`;

  async function booted(application: string): Promise<Kernel> {
    const memory = new MemorySource();
    memory.set("isolated", library("Isolated", "isolated", "Biblioteka"));
    memory.set("shared", library("Shared", "shared", "Wspólna"));
    memory.set("app", application);
    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app");
    await kernel.boot();
    return kernel;
  }

  it("layers imported and inline catalogs in list order, isolated and shared imports alike", async () => {
    const kernel = await booted(`kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
lang: en
imports:
  Iso: memory://isolated
  Sha: memory://shared
translations:
  catalogs:
    - !ref Iso.polish
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: "Save", translation: "Zapisz" }
    - !ref Sha.polish
`);
    try {
      const { translations } = kernel;
      expect(translations.fallback).toBe("en");
      expect(translations.languages()).toEqual(["en", "pl"]);
      expect(translations.translateAll("pl", [text("Library {$n}"), text("Save")]).map((t) => t.text)).toEqual([
        "Wspólna {$n}",
        "Wspólna",
      ]);
    } finally {
      await kernel.teardown();
    }
  });

  it("serves the fallback alone without translations, translating nothing", async () => {
    const kernel = await booted(`kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
`);
    try {
      const save = text("Save");
      expect(kernel.translations.fallback).toBe("und");
      expect(kernel.translations.languages()).toEqual(["und"]);
      expect(kernel.translations.negotiate(["pl"])).toBe("und");
      expect(kernel.translations.translate("pl", save)).toBe(save);
    } finally {
      await kernel.teardown();
    }
  });

  it("defers a question asked before a listed catalog exists", async () => {
    const memory = new MemorySource();
    memory.set("isolated", library("Isolated", "isolated", "Biblioteka"));
    memory.set(
      "app",
      `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
imports:
  Iso: memory://isolated
translations:
  catalogs: [!ref Iso.polish]
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app");
    try {
      expect(() => kernel.translations.languages()).toThrow(
        expect.objectContaining({ code: "ERR_CROSS_MODULE_REF_PENDING" }),
      );
    } finally {
      await kernel.teardown();
    }
  });

  it("reads the set again after a reconciliation, and restarts for an edited catalog", async () => {
    const application = (translation: string, other: string) => `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
lang: en
translations:
  catalogs: [!ref polish]
---
kind: Telo.TextTranslations
metadata: { name: polish }
lang: pl
texts:
  - { text: Save, translation: ${translation} }
---
kind: Telo.JsonSchema
metadata: { name: Other }
schema: { type: ${other} }
`;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-translations-")));
    const file = path.join(dir, "telo.yaml");
    await fs.writeFile(file, application("Zapisz", "string"));
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    try {
      await kernel.load(file);
      await kernel.boot();
      expect(kernel.translations.translate("pl", text("Save")).text).toBe("Zapisz");
      await fs.writeFile(file, application("Zapisz", "number"));
      expect(await kernel.reconcile()).toEqual({ reinitialized: ["Other"], removed: [] });
      expect(kernel.translations.translate("pl", text("Save")).text).toBe("Zapisz");
      await fs.writeFile(file, application("Zachowaj", "number"));
      expect((await kernel.reconcile()).restartRequired).toBe("the application document is in the impact set");
    } finally {
      await kernel.teardown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

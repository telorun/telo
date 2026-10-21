import type { FunctionContext } from "@telorun/sdk";
import { expect, it } from "vitest";
import { catalogSetOf } from "../src/catalog-set.js";
import { Translator } from "../src/translator-controller.js";

const polish = {
  lang: "pl",
  texts: [{ text: "{$n} files", translation: { plural: "n", cases: { one: "{$n} plik", other: "{$n} pliku" } } }],
};
const record = (computed: boolean) => ({ text: "{ $n } files", context: null, lang: "en", computed });

it("reads one catalog set from a translator instance and from a translator's configuration", async () => {
  const instance = await Translator.create(
    { kind: "I18n.Translator", metadata: { name: "t" }, catalogs: [polish] },
    {} as FunctionContext,
  );
  const answer = {
    message: { plural: "n", cases: { one: [{ placeholder: "n" }, " plik"], other: [{ placeholder: "n" }, " pliku"] } },
    lang: "pl",
  };
  for (const translator of [instance, Object.freeze({ catalogs: [polish] })]) {
    const set = catalogSetOf(translator);
    expect(set.languages).toEqual(["pl"]);
    expect(set.lookup(record(false), "pl-PL")).toEqual(answer);
    expect(set.lookup(record(true), "pl")).toBeNull();
  }
  expect(() => catalogSetOf("t")).toThrow(TypeError);
});

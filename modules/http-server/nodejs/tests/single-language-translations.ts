import type { ApplicationTranslations } from "@telorun/sdk";

export const singleLanguageTranslations: ApplicationTranslations = {
  fallback: "en",
  languages: () => ["en"],
  negotiate: () => "en",
  translate: (_lang, record) => record,
  translateAll: (_lang, records) => records,
};

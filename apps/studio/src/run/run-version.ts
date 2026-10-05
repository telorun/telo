import type { TeloLanguage } from "../hooks/useLanguageSession";

/**
 * The telo version a run of the module at `path` asks its runner for: the one
 * the module is edited against — the workspace's pin, or Auto's answer for that
 * module. One version, so what checks the manifest is what runs it.
 *
 * A module nothing serves has no version to ask for. That is a refusal carrying
 * the status that already explains it, never a fallback to some other version:
 * running on one the editor did not check against is the skew this removes.
 */
export function runVersionFor(
  language: TeloLanguage | null,
  path: string,
): { version: string } | { refusal: string } {
  if (language === null) {
    return { refusal: "The telo language tooling is still starting, so this module has no telo version yet." };
  }
  if (language.kind === "failed") {
    return { refusal: `This module has no telo version to run on: ${language.failure}.` };
  }
  const status = language.statusOf(path);
  if (status.version === undefined) {
    return {
      refusal: status.error
        ? `This module has no telo version to run on: ${status.error.message}`
        : "The telo engine for this module is still starting, so it has no telo version yet.",
    };
  }
  return { version: status.version };
}

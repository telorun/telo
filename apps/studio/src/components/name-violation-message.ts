import type { NameLevel, NameViolation } from "@telorun/analyzer";

/**
 * What a rejected name is told to an author who is TYPING it.
 *
 * The analyzer still decides — this only re-words its verdict. Its own messages
 * are written for a diagnostic list, where the reason has to survive without
 * the field in view: they carry the pattern, the CEL scope the name is read
 * through, and the grammar that accepts it. Beside the input, all of that is
 * noise around the one thing the author can act on, which is what to type
 * instead.
 */
export function nameViolationMessage(violation: NameViolation, level: NameLevel): string {
  const example = level === "type" ? "WeatherApi" : "httpServer";
  switch (violation.tier) {
    case "grammar":
      return `Use letters, digits and underscores only, starting with a letter — like ${example}.`;
    case "reserved":
      return "That is a reserved word — pick another name.";
    case "case":
      return level === "type"
        ? `Start with a capital letter — like ${example}.`
        : `Start with a lowercase letter — like ${example}.`;
  }
}

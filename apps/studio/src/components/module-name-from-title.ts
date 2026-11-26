import { checkName } from "@telorun/analyzer";

/** What a new module is saved as: its `metadata.name`, and `metadata.title`
 *  holding the text as typed when that is not itself a valid name. */
export interface NewModuleIdentity {
  name: string;
  title?: string;
}

/**
 * The identity a typed title saves a module under, or undefined when none can
 * be derived. A valid name is used as is; otherwise the derived PascalCase name
 * is used and the typed text kept as the title. Validity is the analyzer's own
 * rule, so a name accepted here is one `telo check` accepts.
 */
export function moduleIdentityFromTitle(typed: string, kindLabel: string): NewModuleIdentity | undefined {
  const title = typed.trim();
  if (!title) return undefined;
  if (!checkName(title, "type", kindLabel)) return { name: title };
  const name = moduleNameFromTitle(title);
  return name && !checkName(name, "type", kindLabel) ? { name, title } : undefined;
}

/**
 * The PascalCase module name a free-text title is saved under ("hello world" →
 * `HelloWorld`, "my API v2" → `MyAPIV2`).
 *
 * Words split on anything that is not a letter or digit and on lower-to-upper
 * case boundaries; each word's first letter is capitalised and the rest kept as
 * typed, and digits leading the result are dropped because a name must start
 * with a letter. Undefined when nothing usable is left.
 */
export function moduleNameFromTitle(title: string): string | undefined {
  const name = title
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("")
    .replace(/^[0-9]+/, "");
  return name === "" ? undefined : name;
}

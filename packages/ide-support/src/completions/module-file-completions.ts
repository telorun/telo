import type { CompletionResult, IdeEnvironmentAdapter, ReplaceRange } from "../types.js";

/** Caps one listing; a popover shows far fewer. */
const ENTRY_LIMIT = 200;

/**
 * Completions for the value of a tag naming a location inside the module
 * (`!include-text`, `!include-bytes`, `!module-path`).
 *
 * Paths are measured from the MODULE ROOT, never from the declaring file, so the
 * listing is asked of the host against that root. The typed text up to its last
 * `/` is the directory listed, and is kept on every insertion, so `./` stays
 * where the author wrote it. A directory is a value in its own right where the
 * tag may name one; where it names a file, a directory is only a way down, so a
 * pick inserts its `/` and reopens completion. Dot-entries are listed only once
 * the typed name starts with `.`, as a shell completes them.
 *
 * Nothing is offered above the root or for an absolute or URL-shaped path: the
 * tag refuses those, and a listing there would offer what cannot be written.
 */
export async function moduleFileCompletions(
  names: "file" | "file-or-directory",
  prefix: string,
  replaceRange: ReplaceRange,
  adapter: IdeEnvironmentAdapter | undefined,
): Promise<CompletionResult[]> {
  if (!adapter || /^["']/.test(prefix)) return [];
  const lastSlash = prefix.lastIndexOf("/");
  const dirPart = prefix.slice(0, lastSlash + 1);
  const namePart = prefix.slice(lastSlash + 1);
  if (!staysInModule(dirPart)) return [];

  const entries = await adapter.listModuleEntries(dirPart === "" ? "." : dirPart);
  return entries
    .filter((e) => e.name.startsWith(namePart) && (namePart.startsWith(".") || !e.name.startsWith(".")))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    .slice(0, ENTRY_LIMIT)
    .map((entry) => {
      const navigateOnly = entry.directory && names === "file";
      const path = dirPart + entry.name + (navigateOnly ? "/" : "");
      return {
        label: entry.directory ? `${entry.name}/` : entry.name,
        kind: entry.directory ? "folder" : "file",
        insertText: path,
        filterText: path,
        replaceRange,
        retrigger: navigateOnly,
        sortText: `${entry.directory ? 0 : 1}_${entry.name}`,
      } satisfies CompletionResult;
    });
}

/** Whether a module-root-relative directory stays inside the module. Pure string
 *  work, by the rule the tags' own path grammar applies. */
function staysInModule(dir: string): boolean {
  if (/^([/\\]|[a-z][a-z0-9+.-]*:)/i.test(dir)) return false;
  let depth = 0;
  for (const segment of dir.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") continue;
    depth += segment === ".." ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

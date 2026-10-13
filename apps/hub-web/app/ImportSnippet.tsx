import { CodeBlock } from "@/CodeBlock";

/** `HttpServer`, `S3` — a declared module name is already a legal import alias.
 *  A ref-tail fallback (`telo-s3`) is not one, so it is rebuilt in PascalCase. */
export function importAlias(name: string): string {
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return name;
  const alias = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Z]/.test(alias) ? alias : "Alias";
}

/** The pinned source an `imports:` entry holds: `ref@version#integrity`, the
 *  pin left off when nothing can hash the ref. */
export function pinnedSource(ref: string, version: string, integrity?: string): string {
  return `${ref}@${version}${integrity ? `#${integrity}` : ""}`;
}

/** The lines to paste into a manifest to import a module. The alias is the
 *  module's own name — a suggestion the importer may change, and the prefix its
 *  kinds are written under. Shown under its `imports:` key for context; what is
 *  copied is the entry alone, because the manifest it lands in already has the
 *  key. */
export function ImportSnippet({ name, source }: { name: string; source: string }) {
  const entry = `${importAlias(name)}: ${source}`;
  return <CodeBlock text={`imports:\n  ${entry}`} copy={entry} label="Copy import entry" />;
}

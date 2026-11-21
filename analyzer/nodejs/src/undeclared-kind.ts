/**
 * A kind spelled through an import whose module does not declare it. Kind
 * resolution asks whether the target module declares the kind before it asks
 * whether the module exports it: an undeclared one is `UNDEFINED_KIND`, and
 * `KIND_NOT_EXPORTED` is only for a kind the module declares and withholds.
 * The existence check reads the import's resolved module identity, never the
 * alias as written. Shared by the analyzer's emitters and the kernel's
 * resolution, so both word the refusal alike.
 *
 * Browser-safe.
 */
import { readLibraryMigrations, rootKindWritten } from "./library-migrations/declaration.js";

/**
 * The reason of the target library's migration that removes `name` — one of
 * its rules rewriting the type writes `kind:` at its root — or undefined.
 */
export function removedKindReason(moduleDoc: unknown, name: string): string | undefined {
  for (const migration of readLibraryMigrations(moduleDoc)) {
    if (migration.rules.some((rule) => rule.rewrite === name && rootKindWritten(rule) !== undefined)) {
      return migration.reason;
    }
  }
  return undefined;
}

/** The refusal of `kind`, written as the author spelled it, whose module
 *  `module` declares no kind `name`. */
export function undeclaredKindMessage(kind: string, module: string, name: string, reason: string | undefined): string {
  return (
    `No Telo.Definition found for kind '${kind}': module '${module}' declares no kind '${name}'.` +
    (reason !== undefined ? ` It was removed: ${reason}` : "")
  );
}

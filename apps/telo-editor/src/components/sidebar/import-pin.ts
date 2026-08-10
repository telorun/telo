import { foldIntegrity, parseVersionedRef, withRefVersion } from "@telorun/analyzer";
import type { ModuleVersion } from "../../hub-search";
import type { ParsedImport } from "../../model";

/** True when the import carries an integrity pin in either of the two places one
 *  can be written: a `#sha256-…` fragment on the source, or the object form's
 *  `integrity:` sibling. A re-point drops both, so both count as pinned — the
 *  sibling form used to read as unpinned, which is how it came to be deleted
 *  without even a warning. */
export function isImportPinned(imp: ParsedImport): boolean {
  return imp.integrity != null || parseVersionedRef(imp.source)?.integrity != null;
}

/** The source for `imp` re-pointed at `version`, pinned when the hub published a
 *  hash for that version.
 *
 *  The old pin is never carried over: `withRefVersion` sheds the fragment, and
 *  the object form's sibling is dropped at write-back. It hashes the `telo.yaml`
 *  of the version being replaced, so keeping it would turn the next install into
 *  a tamper error. The hub's pin is the only one available here — a browser
 *  cannot fetch and hash a module over an arbitrary transport, which is why the
 *  result is unpinned when the hub reports no hash and `telo upgrade` is what
 *  recovers it. */
export function upgradedImportSource(imp: ParsedImport, version: ModuleVersion): string {
  return foldIntegrity(withRefVersion(imp.source, version.version), version.integrity);
}

/**
 * Reading and writing `.changes/ledger.yaml`, and the pending fragment
 * directory beside it.
 *
 * The Node half only — the shapes and their parsers are the analyzer's, so the
 * editor reads the same files the same way.
 */

import {
  EMPTY_LEDGER,
  LEDGER_PATH,
  parseFragment,
  parseLedger,
  serializeLedger,
  type Ledger,
  type ReleaseFragment,
} from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";

/** Where a fragment waits to be released. Sits under `.changes/` beside the
 *  ledger, so everything the release system owns is in one directory. */
export const PENDING_DIR = ".changes/pending";

export function readLedger(root: string): Ledger {
  const file = path.join(root, LEDGER_PATH);
  if (!fs.existsSync(file)) return EMPTY_LEDGER;
  return parseLedger(fs.readFileSync(file, "utf8"), LEDGER_PATH);
}

export function writeLedger(root: string, ledger: Ledger): void {
  const file = path.join(root, LEDGER_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeLedger(ledger), "utf8");
}

/** Every pending fragment, in filename order so a plan's changelog entries land
 *  in a stable order across runs. */
export function readFragments(root: string): ReleaseFragment[] {
  const dir = path.join(root, PENDING_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => {
      const source = `${PENDING_DIR}/${name}`;
      return parseFragment(fs.readFileSync(path.join(dir, name), "utf8"), source);
    });
}

/**
 * Write a fragment, never over one that already exists.
 *
 * The filename is derived from the kind and the first words of the body, which
 * is what makes the pending directory readable — and what makes a collision
 * possible. Silently overwriting would delete somebody's changelog line, so a
 * taken name gets a `-2` rather than the file it names.
 */
export function writeFragment(root: string, name: string, text: string): string {
  const dir = path.join(root, PENDING_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const [, stem, ext] = /^(.*?)(\.[^.]+)$/.exec(name) ?? [undefined, name, ""];
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  fs.writeFileSync(path.join(dir, candidate), text, "utf8");
  return `${PENDING_DIR}/${candidate}`;
}

export function deleteFragment(root: string, source: string): void {
  fs.rmSync(path.join(root, source), { force: true });
}

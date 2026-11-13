/**
 * Reading and writing `.changes/ledger.yaml` and the pending fragments beside
 * it. The shapes and their parsers are the main entry's; this is the disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFragment, type ReleaseFragment } from "../fragment.js";
import {
  EMPTY_LEDGER,
  LEDGER_PATH,
  parseLedger,
  serializeLedger,
  type Ledger,
  type ParseLedgerOptions,
} from "../ledger.js";

/** Where a fragment waits to be released. */
export const PENDING_DIR = ".changes/pending";

export function readLedger(root: string, options: ParseLedgerOptions = {}): Ledger {
  const file = path.join(root, LEDGER_PATH);
  if (!fs.existsSync(file)) return EMPTY_LEDGER;
  return parseLedger(fs.readFileSync(file, "utf8"), LEDGER_PATH, options);
}

export function writeLedger(root: string, ledger: Ledger): void {
  const file = path.join(root, LEDGER_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeLedger(ledger), "utf8");
}

/** Every pending fragment, in filename order so changelog entries land in a
 *  stable order across runs. */
export function readFragments(root: string): ReleaseFragment[] {
  const dir = path.join(root, PENDING_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => parseFragment(fs.readFileSync(path.join(dir, name), "utf8"), `${PENDING_DIR}/${name}`));
}

/**
 * Write a fragment, never over one that already exists: a taken name gets a
 * `-2` rather than replacing somebody's changelog line.
 */
export function writeFragment(root: string, name: string, text: string): string {
  const dir = path.join(root, PENDING_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const [, stem, ext] = /^(.*?)(\.[^.]+)$/.exec(name) ?? [undefined, name, ""];
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${stem}-${n}${ext}`;
  fs.writeFileSync(path.join(dir, candidate), text, "utf8");
  return `${PENDING_DIR}/${candidate}`;
}

export function deleteFragment(root: string, source: string): void {
  fs.rmSync(path.join(root, source), { force: true });
}

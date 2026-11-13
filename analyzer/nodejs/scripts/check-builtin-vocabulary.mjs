#!/usr/bin/env node
// The publish guard (`prepack`): a published `@telorun/analyzer@X` must carry
// the built-in vocabulary of telo `X`. The publish workflow reconciles
// `oci://<registry>/telo@X` from exactly this package's
// `src/builtin-vocabulary/` (`scripts/publish-builtins.mjs`), so an archive of
// another version — `X+unreleased`, which every build but the published one
// renders — would publish the wrong bytes under the release's tag.
//
// It runs after the prepack rendered the archive with `--published` and rebuilt
// the package, and refuses the tarball unless three things hold: `builtins.yaml` carries exactly
// the package version, the `BUILTIN_VOCABULARY_ARCHIVE` constant this package
// exports — the source module and the built one — is that file's bytes, and the
// `LICENSE` beside it is `sdk/LICENSE`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE, "../..");
const ARCHIVE_DIR = join(PACKAGE, "src", "builtin-vocabulary");

function refuse(message) {
  console.error(`analyzer: refusing to pack — ${message}`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
const archive = readFileSync(join(ARCHIVE_DIR, "builtins.yaml"), "utf8");

// The renderer's fixed layout: the root's `metadata:` block holds `version:`,
// written plain or as a JSON string.
const metadata = /^metadata:\n((?: {2}.*\n)+)/m.exec(archive.split("\n---\n")[0] + "\n")?.[1] ?? "";
const written = /^ {2}version: (.+)$/m.exec(metadata)?.[1];
const archiveVersion = written?.startsWith('"') ? JSON.parse(written) : written;
if (archiveVersion !== version) {
  refuse(
    `src/builtin-vocabulary/builtins.yaml is the vocabulary of telo ${archiveVersion}, not ${version}: the ` +
      `prepack renders it with \`render-builtin-vocabulary.mjs --published\`; pack the package rather than ` +
      `publishing its files.`,
  );
}

const CONSTANT = /BUILTIN_VOCABULARY_ARCHIVE(?:: string)? = ("(?:[^"\\]|\\.)*");/;
for (const module of [join("src", "builtin-vocabulary", "index.ts"), join("dist", "builtin-vocabulary", "index.js")]) {
  const path = join(PACKAGE, module);
  if (!existsSync(path)) refuse(`${module} does not exist — build the package before packing it.`);
  const literal = CONSTANT.exec(readFileSync(path, "utf8"))?.[1];
  if (literal === undefined || JSON.parse(literal) !== archive) {
    refuse(
      `${module} does not export src/builtin-vocabulary/builtins.yaml byte for byte — rebuild the package ` +
        `from this tree before packing it.`,
    );
  }
}

const license = readFileSync(join(ARCHIVE_DIR, "LICENSE"));
if (!license.equals(readFileSync(join(ROOT, "sdk", "LICENSE")))) {
  refuse("src/builtin-vocabulary/LICENSE is not sdk/LICENSE byte for byte.");
}

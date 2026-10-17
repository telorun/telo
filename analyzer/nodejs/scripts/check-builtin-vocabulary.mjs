#!/usr/bin/env node
// The publish guard (`prepack`): a published `@telorun/analyzer@X` must carry
// the built-in vocabulary of telo `X`. The publish workflow reconciles
// `oci://<registry>/telo@X` from exactly this package's
// `src/builtin-vocabulary/` (`scripts/publish-builtins.mjs`), so an archive of
// another version — `X+unreleased`, rendered while a line changeset is pending —
// would publish the wrong bytes under the release's tag.
//
// It renders the archive from the tree (both generators, dependency-free) and
// refuses the tarball unless three things hold: `builtins.yaml` carries exactly
// the package version, the `BUILTIN_VOCABULARY_ARCHIVE` constant this package
// exports — the source module and the built one — is that file's bytes, and the
// `LICENSE` beside it is `sdk/LICENSE`.

import { execFileSync } from "node:child_process";
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

for (const script of ["generate-telo-version.mjs", "render-builtin-vocabulary.mjs"]) {
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", script)], { stdio: "inherit" });
  } catch {
    refuse(`the built-in vocabulary could not be rendered from this tree (scripts/${script} said why above).`);
  }
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
    `src/builtin-vocabulary/builtins.yaml is the vocabulary of telo ${archiveVersion}, not ${version}: a ` +
      `changeset of the telo version line is still pending. Publish after the Version PR has moved the line ` +
      `to the release.`,
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

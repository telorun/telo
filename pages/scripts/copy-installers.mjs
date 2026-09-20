#!/usr/bin/env node
/**
 * Copy the install scripts into the site's static files, so they are served at
 * `https://telo.run/install.sh` and `https://telo.run/install.ps1`.
 *
 * The scripts live at the repo root, which is where they belong: they install
 * the product, not the documentation, and not `cli/nodejs`. Copying them at
 * build time rather than committing a second copy keeps one source of truth —
 * two copies of a `curl | sh` script drift, and the one people actually run
 * would be the stale one.
 *
 * Why the site serves them at all: the advertised install command is the
 * product's single most permanent URL. Pointing it at
 * `raw.githubusercontent.com/<org>/<repo>/main/install.sh` pins it to a git
 * host, an organisation, a repository name and a branch — four things that are
 * not the product, in the first line anyone pastes into a Dockerfile.
 *
 * The ADVERTISED command is now `https://telo.sh/install.sh`, which redirects
 * to the copy at a release tag; these files are the mirror that keeps
 * `telo.run/install.sh` resolving for everyone who already pasted it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PAGES, "..");
const INSTALLERS = ["install.sh", "install.ps1"];

for (const name of INSTALLERS) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) {
    throw new Error(
      `${name} is missing from the repository root; the site cannot serve an install command that does not exist.`,
    );
  }
  fs.copyFileSync(from, path.join(PAGES, "static", name));
}

process.stderr.write(`copied ${INSTALLERS.join(", ")} into pages/static/\n`);

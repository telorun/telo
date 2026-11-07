#!/usr/bin/env node
// Links in tracked markdown (and a module's telo.yaml) point at the repository by
// RELATIVE path only. GitHub resolves a relative link against the ref being viewed,
// and the site build and the npm / .vsix packing rewrite it to the tag they
// publish; an absolute URL into the tree is pinned to one ref and goes stale.
// A module's files are published as the module's own bytes, so they may not
// reference the repository tree at all.
//
// Scope: every tracked `*.md` / `*.mdx` except changelogs, plus `modules/**/telo.yaml`
// (absolute-URL and preview rules only). Links inside fenced code and code spans
// are examples, not links.
//
// Usage: node scripts/check-links.mjs     (exit 1 when any link is refused)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = "https://hub.telo.run/module/oci/ghcr.io/telorun";
const REPO_URL = /\bhttps?:\/\/(?:github\.com\/telorun\/telo\/(?:blob|tree)\/|raw\.githubusercontent\.com\/telorun\/telo\/)[^\s)>\]"'`]*/g;
const PREVIEW_URL = /\bhttps?:\/\/telo\.run\/next(?:\/[^\s)>\]"'`]*)?/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Module roots: directories under modules/ holding a tracked telo.yaml, tests and fixtures excluded. */
function moduleRoots(files) {
  return files
    .filter((f) => f.startsWith("modules/") && basename(f) === "telo.yaml")
    .map((f) => posix.dirname(f))
    .filter((dir) => !dir.split("/").some((part) => part === "tests" || part === "__fixtures__"));
}

function innermost(roots, file) {
  let best = null;
  for (const root of roots) {
    if (file.startsWith(`${root}/`) && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/** [{ line, text }] of the link-bearing prose of a markdown text, code removed. */
function proseLines(text) {
  const out = [];
  let fence = null;
  text.split("\n").forEach((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return;
    }
    if (fence === null) out.push({ line: index + 1, text: line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)) });
  });
  return out;
}

/** Destinations written as a link: inline, reference definition, html attribute. */
function destinations(text) {
  const found = [];
  for (const m of text.matchAll(/\]\(\s*(<[^>]*>|[^\s)]*)/g)) found.push(m[1].replace(/^<|>$/g, ""));
  const ref = text.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
  if (ref) found.push(ref[1]);
  for (const m of text.matchAll(/\b(?:href|src)=("|')([^"']*)\1/g)) found.push(m[2]);
  return found;
}

export function refusalsFor({ root, files }) {
  const tracked = new Set(files);
  const dirs = new Set();
  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir);
  }
  const roots = moduleRoots(files);
  const nameOf = (dir) => dir.replace(/^modules\//, "").replaceAll("/", "-");
  const refused = [];

  for (const file of files) {
    const isMarkdown = /\.mdx?$/.test(file) && basename(file) !== "CHANGELOG.md";
    const isModuleManifest = file.startsWith("modules/") && basename(file) === "telo.yaml";
    if (!isMarkdown && !isModuleManifest) continue;
    const own = file.startsWith("modules/") ? innermost(roots, file) : null;
    const source = readFileSync(resolve(root, file), "utf8");
    const lines = isMarkdown ? proseLines(source) : source.split("\n").map((text, i) => ({ line: i + 1, text }));

    for (const { line, text } of lines) {
      const refuse = (target, reason) => refused.push({ file, line, target, reason });
      for (const [match] of text.matchAll(REPO_URL)) {
        refuse(match, "links into the repository by URL — write a relative path");
      }
      for (const [match] of own !== null ? text.matchAll(PREVIEW_URL) : []) {
        const rest = match.replace(/^https?:\/\/telo\.run\/next\/?/, "");
        refuse(match, `names a preview — link to https://telo.run/${rest}`);
      }
      if (!isMarkdown) continue;

      for (const href of destinations(text)) {
        if (!href || href.startsWith("#") || href.startsWith("/") || SCHEME.test(href) || /[{}$<>]/.test(href)) continue;
        const cut = href.search(/[?#]/);
        let target = cut < 0 ? href : href.slice(0, cut);
        if (!target) continue;
        try {
          target = decodeURI(target);
        } catch {
          // an undecodable target is compared as written
        }
        const rel = posix.normalize(posix.join(posix.dirname(file), target)).replace(/\/$/, "");
        const exists = !rel.startsWith("..") && (tracked.has(rel) || dirs.has(rel));
        if (!exists) {
          refuse(href, "names no tracked file");
          continue;
        }
        if (own !== null && rel !== own && !rel.startsWith(`${own}/`)) {
          const other = innermost(roots, `${rel}/`) ?? innermost(roots, rel);
          const hint = other ? `${HUB}/${nameOf(other)}/` : "a docs page (https://telo.run/…) or another module's hub page";
          refuse(href, `leaves the module — link to ${hint}`);
        }
      }
    }
  }
  return refused;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter(Boolean);
  const refused = refusalsFor({ root, files });
  for (const { file, line, target, reason } of refused) console.log(`${file}:${line}  ${target}  ${reason}`);
  if (refused.length > 0) {
    console.log(`${refused.length} link${refused.length === 1 ? "" : "s"} refused`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

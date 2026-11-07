// Resolves a relative link in a repository file to a URL into the repository at
// a tag. One definition for the docs site build, the llms.txt companions, and
// the npm / .vsix packing, so the three cannot disagree on what a link becomes.
// CommonJS because the Docusaurus plugins `require` it and ESM scripts import it.

const fs = require("node:fs");
const path = require("node:path");

const REPO_URL = "https://github.com/telorun/telo";
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {string} href the link as written
 * @param {{ repoRoot: string, fromDir: string, tag: string, image?: boolean }} ctx
 *   `fromDir` is the repo-relative (posix) directory of the file the link is written in.
 * @returns {string | null} the URL, or null when the link is not a relative link to an existing repo path
 */
function repoUrl(href, { repoRoot, fromDir, tag, image = false }) {
  if (!href || href.startsWith("#") || href.startsWith("/") || SCHEME.test(href)) return null;
  const cut = href.search(/[?#]/);
  const target = cut < 0 ? href : href.slice(0, cut);
  const suffix = cut < 0 ? "" : href.slice(cut);
  if (!target) return null;
  let decoded;
  try {
    decoded = decodeURI(target);
  } catch {
    return null;
  }
  const rel = path.posix.normalize(path.posix.join(fromDir || ".", decoded));
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
  let stat;
  try {
    stat = fs.statSync(path.join(repoRoot, rel));
  } catch {
    return null;
  }
  const kind = stat.isDirectory() ? "tree" : image ? "raw" : "blob";
  const clean = rel.replace(/\/$/, "");
  const trailing = target.endsWith("/") && stat.isDirectory() ? "/" : "";
  return `${REPO_URL}/${kind}/${tag}/${encodeURI(clean)}${trailing}${suffix}`;
}

/**
 * Rewrites the relative links of one markdown text to repository URLs. Fenced
 * code is left alone; a link to nothing in the repository is left as written.
 */
function rewriteMarkdownLinks(text, ctx) {
  const swap = (href, image) => repoUrl(href, { ...ctx, image }) ?? href;
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (fence === null) fence = marker[1][0];
        else if (marker[1][0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line
        .replace(/(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^\s)]*)/g, (all, bang, label, dest) => {
          const bare = dest.startsWith("<") ? dest.slice(1, -1) : dest;
          const next = swap(bare, bang === "!");
          return next === bare ? all : `${bang}[${label}](${dest.startsWith("<") ? `<${next}>` : next}`;
        })
        .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/, (all, head, dest) => {
          const next = swap(dest, false);
          return next === dest ? all : head + next;
        })
        .replace(/\b(href|src)=("|')([^"']*)\2/g, (all, attr, quote, dest) => {
          const next = swap(dest, attr === "src");
          return next === dest ? all : `${attr}=${quote}${next}${quote}`;
        });
    })
    .join("\n");
}

module.exports = { repoUrl, rewriteMarkdownLinks, REPO_URL };

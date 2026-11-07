// Remark plugin: a relative link in a doc that the site does not render becomes a
// link into the repository at the tag being built (TELO_SITE_TAG), so a link to a
// spec or a source file reads the same tree the site was built from. A link to a
// page the site renders is left for Docusaurus to turn into a site link; a link to
// nothing in the repository is left as written (`pnpm run check:links` owns it).
//
// Registered BEFORE Docusaurus' own link handling: that step would otherwise
// bundle a linked non-markdown file into the build as an asset.

const path = require("node:path");
const { repoUrl } = require("../../scripts/repo-links.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");

module.exports = function remarkRepoLinks({ rendered, tag }) {
  const renderedPaths = new Set(rendered);
  return (tree, file) => {
    if (!file || !file.path) return;
    const fromDir = path.relative(repoRoot, path.dirname(file.path)).split(path.sep).join("/");
    const rewrite = (node) => {
      const url = node.url;
      if (typeof url !== "string") return;
      const written = url.split(/[?#]/)[0];
      if (written && renderedPaths.has(path.posix.normalize(path.posix.join(fromDir, written)))) return;
      node.url = repoUrl(url, { repoRoot, fromDir, tag }) ?? url;
    };
    const walk = (node) => {
      // Images stay Docusaurus', which bundles them with the build.
      if (node.type === "link" || node.type === "definition") rewrite(node);
      if (Array.isArray(node.children)) for (const child of node.children) walk(child);
    };
    walk(tree);
  };
};

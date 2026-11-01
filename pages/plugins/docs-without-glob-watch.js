// The docs plugin watches `<path>/**/_category_.*`. With `path: ".."` that walks
// the whole repo, every node_modules and worktree included, which exhausts
// inotify or stalls the polling dev server. No doc here uses a category file,
// so only the explicit per-file watches are kept.

const docs = require("@docusaurus/plugin-content-docs");

module.exports = async function docsWithoutGlobWatch(context, options) {
  const plugin = await docs.default(context, options);
  return {
    ...plugin,
    getPathsToWatch: () => plugin.getPathsToWatch().filter((pattern) => !pattern.includes("**")),
  };
};

module.exports.validateOptions = docs.validateOptions;

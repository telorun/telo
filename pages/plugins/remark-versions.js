// Remark plugin: substitute the `<version>` marker in package refs at build
// time, so the rendered HTML carries real versions sourced from local files.
// See pages/lib/version-map.js for the resolution rules.
//
// Markers live in fenced code (`code`), inline code (`inlineCode`), and prose
// (`text`) — we walk those node values directly rather than re-parsing.

const { buildVersionMap, substituteVersions } = require("../lib/version-map");

module.exports = function remarkVersions() {
  const map = buildVersionMap();
  return (tree, file) => {
    const source = file && file.path;
    const walk = (node) => {
      if (
        typeof node.value === "string" &&
        (node.type === "code" || node.type === "inlineCode" || node.type === "text")
      ) {
        node.value = substituteVersions(node.value, map, source);
      }
      if (Array.isArray(node.children)) for (const child of node.children) walk(child);
    };
    walk(tree);
  };
};

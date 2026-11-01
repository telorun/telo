// Remark plugin: highlight code fences with Shiki at build time, so every block
// shares one look. YAML uses the Telo TextMate grammar the VS Code extension
// ships, coloring `!cel`, `!ref` and CEL bodies the way the editor does. A
// language outside the table keeps Docusaurus's own block.

const fs = require("node:fs");
const path = require("node:path");

const GRAMMAR = path.resolve(__dirname, "../../ide/vscode/syntaxes/telo.tmLanguage.json");
// Fence language -> Shiki language; an unlabeled fence is plain text.
const LANGS = {
  yaml: "telo",
  yml: "telo",
  telo: "telo",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "shellsession",
  powershell: "powershell",
  ts: "ts",
  typescript: "ts",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  toml: "toml",
  diff: "diff",
  html: "html",
  css: "css",
  tsx: "tsx",
  json: "json",
  dockerfile: "dockerfile",
  sql: "sql",
  rust: "rust",
  ini: "ini",
  text: "text",
  txt: "text",
};
// Docusaurus code blocks are dark (palenight) in both site modes, so these are too.
const THEME = "dark-plus";

let highlighter;
function loadHighlighter() {
  highlighter ??= import("shiki").then(({ createHighlighter }) =>
    createHighlighter({
      themes: [THEME],
      langs: [...new Set(Object.values(LANGS).filter((lang) => lang !== "telo" && lang !== "text")), "yaml", { ...JSON.parse(fs.readFileSync(GRAMMAR, "utf8")), name: "telo" }],
    }),
  );
  return highlighter;
}

module.exports = function remarkShiki() {
  return async (tree) => {
    const blocks = [];
    const walk = (node, parent) => {
      if (node.type === "code" && !node.meta && (node.lang ?? "text") in LANGS) {
        blocks.push({ node, parent });
      }
      if (Array.isArray(node.children)) for (const child of node.children) walk(child, node);
    };
    walk(tree, null);
    if (blocks.length === 0) return;

    const shiki = await loadHighlighter();
    for (const { node, parent } of blocks) {
      const html = shiki.codeToHtml(node.value, {
        lang: LANGS[node.lang ?? "text"],
        theme: THEME,
      });
      const index = parent.children.indexOf(node);
      parent.children[index] = {
        type: "mdxJsxFlowElement",
        name: "TeloCode",
        attributes: [
          { type: "mdxJsxAttribute", name: "html", value: html },
          { type: "mdxJsxAttribute", name: "code", value: node.value },
        ],
        children: [],
      };
    }
  };
};

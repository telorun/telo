// The engine ships as ONE self-contained ES module that a host loads into a
// worker from bytes it verified — so nothing in it may reach for another file,
// a Node built-in or a CommonJS loader. This reads the built file as a program
// (not as text: the bundle legitimately carries strings such as AJV's code
// generation templates that merely look like `require(...)`) and lists every
// escape hatch left in it.

import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";

/** Findings as `line:column  what`, empty when the bundle is self-contained. */
export function bundleEscapes(code) {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const found = [];
  const at = (node, what) => found.push({ node, what });

  fullAncestor(program, (node, _state, ancestors) => {
    switch (node.type) {
      case "ImportDeclaration":
        at(node, `static import of '${node.source.value}'`);
        break;
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
        if (node.source) at(node, `re-export from '${node.source.value}'`);
        break;
      case "ImportExpression":
        at(node, "dynamic import()");
        break;
      case "Identifier": {
        if (node.name !== "require") break;
        const parent = ancestors[ancestors.length - 2];
        const isPropertyName =
          (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
          (parent?.type === "Property" && parent.key === node && !parent.computed) ||
          (parent?.type === "MethodDefinition" && parent.key === node);
        if (!isPropertyName) at(node, "reference to `require`");
        break;
      }
      case "Literal":
        if (typeof node.value === "string" && node.value.startsWith("node:")) {
          at(node, `Node built-in specifier '${node.value}'`);
        }
        break;
    }
  });
  return found
    .sort((a, b) => a.node.start - b.node.start)
    .map(({ node, what }) => `${node.loc.start.line}:${node.loc.start.column + 1}  ${what}`);
}

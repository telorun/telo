/**
 * Traverses a definition schema and collects all paths annotated with `x-telo-eval`.
 * Root-level `x-telo-eval` produces the `"**"` wildcard (expand all fields).
 * Property-level annotations produce the dot-notation path to that property.
 */
export function buildEvalPaths(schema: Record<string, any>): {
  compile: string[];
  runtime: string[];
} {
  const compile: string[] = [];
  const runtime: string[] = [];

  if (schema["x-telo-eval"] === "compile") compile.push("**");
  else if (schema["x-telo-eval"] === "runtime") runtime.push("**");

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      collectEvalPathsNode(propSchema, key, compile, runtime);
    }
  }

  return { compile, runtime };
}

function collectEvalPathsNode(
  node: Record<string, any>,
  path: string,
  compile: string[],
  runtime: string[],
): void {
  if (node["x-telo-eval"] === "compile") {
    compile.push(path);
    return;
  }
  if (node["x-telo-eval"] === "runtime") {
    runtime.push(path);
    return;
  }
  if (node.properties) {
    for (const [key, propSchema] of Object.entries(node.properties as Record<string, any>)) {
      collectEvalPathsNode(propSchema, `${path}.${key}`, compile, runtime);
    }
  }
}

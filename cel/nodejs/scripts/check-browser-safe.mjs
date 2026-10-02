/**
 * Refuses a package entry that reaches a Node built-in.
 *
 * The analyzer loads this engine in a browser, so `node:fs` reachable from the
 * entry is a failure at load there — and one that no unit test sees, because every
 * test runs on Node. The check is a real bundle rather than a scan of import lines:
 * it resolves under the `browser` export condition and follows transitive
 * third-party dependencies, so a dependency that only reaches a built-in through
 * its own dependency is caught too.
 *
 * A built-in appears as an unresolvable import under `platform: "browser"`, which
 * is what esbuild reports; the plugin below names it explicitly so the failure says
 * which module asked for what.
 */
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Reports every resolution of a Node built-in, with the file that asked for it. */
const refuseBuiltins = {
  name: "refuse-node-builtins",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      if (!builtins.has(args.path)) return undefined;
      return {
        errors: [{ text: `${args.importer} imports the Node built-in ${JSON.stringify(args.path)}` }],
      };
    });
  },
};

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2024",
  conditions: ["browser", "source"],
  logLevel: "silent",
  plugins: [refuseBuiltins],
}).catch((error) => error);

if (result.errors?.length) {
  console.error("@telorun/cel is not browser-safe:");
  for (const error of result.errors) {
    console.error(`  ${error.text}${error.location ? ` (${error.location.file}:${error.location.line})` : ""}`);
  }
  process.exit(1);
}

const bytes = result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
console.log(`@telorun/cel is browser-safe: bundled ${bytes} bytes with no Node built-in.`);

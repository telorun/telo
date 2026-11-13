/**
 * Refuses a main entry that reaches a Node built-in or a package outside the MIT
 * set this package may depend on. The planner runs in an editor's browser, so a
 * built-in reachable from the entry fails at load there — and no unit test sees
 * it, since every test runs on Node. The check is a real bundle under the
 * `browser` condition, so a dependency reaching a built-in through its own
 * dependency is caught too.
 */
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
/** Sustainable Use packages an MIT package must never reach. */
const RESTRICTED = /^@telorun\/(analyzer|kernel|cli|templating|cel|ide-support|language-server|language-host|runner-core)(\/|$)/;

const refuse = {
  name: "refuse-node-builtins-and-restricted",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      if (builtins.has(args.path)) {
        return { errors: [{ text: `${args.importer} imports the Node built-in ${JSON.stringify(args.path)}` }] };
      }
      if (RESTRICTED.test(args.path)) {
        return { errors: [{ text: `${args.importer} imports ${JSON.stringify(args.path)}, which is not MIT` }] };
      }
      return undefined;
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
  plugins: [refuse],
}).catch((error) => error);

if (result.errors?.length) {
  console.error("@telorun/release is not browser-safe:");
  for (const error of result.errors) {
    console.error(`  ${error.text}${error.location ? ` (${error.location.file}:${error.location.line})` : ""}`);
  }
  process.exit(1);
}

const bytes = result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
console.log(`@telorun/release is browser-safe: bundled ${bytes} bytes with no Node built-in and no restricted package.`);

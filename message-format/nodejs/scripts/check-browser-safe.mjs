/**
 * Refuses a package entry that reaches a Node built-in, and any source file or the
 * bundle that names the host's locale data (`Intl`, `toLocale…`, `localeCompare`):
 * the core answers from its pinned CLDR data alone, so Node, Rust and every browser
 * format one message identically.
 *
 * The analyzer loads this core in a browser, so `node:fs` reachable from the
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
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
const entry = join(sourceDir, "index.ts");
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
  console.error("@telorun/message-format is not browser-safe:");
  for (const error of result.errors) {
    console.error(`  ${error.text}${error.location ? ` (${error.location.file}:${error.location.line})` : ""}`);
  }
  process.exit(1);
}

// The core's answers must not depend on the host's locale data. Each source file is
// read as compiled on its own, so code the bundle shakes out is judged too, and a
// comment naming one of them is not.
const HOST_LOCALE = /\bIntl\b|\btoLocale[A-Za-z]*\b|\blocaleCompare\b/;
const hostLocaleReads = [];
for (const file of readdirSync(sourceDir, { recursive: true })) {
  if (!/\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
  const path = join(sourceDir, file);
  const { code } = await transform(readFileSync(path, "utf8"), { loader: file.endsWith(".tsx") ? "tsx" : "ts" });
  const found = code.match(HOST_LOCALE);
  if (found) hostLocaleReads.push(`${path} names ${found[0]}`);
}
const bundled = result.outputFiles.map((file) => file.text).join("\n").match(HOST_LOCALE);
if (bundled) hostLocaleReads.push(`the bundle names ${bundled[0]}`);
if (hostLocaleReads.length) {
  console.error("@telorun/message-format reaches the host's locale data:");
  for (const read of hostLocaleReads) console.error(`  ${read}`);
  process.exit(1);
}

const bytes = result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
console.log(`@telorun/message-format is browser-safe: bundled ${bytes} bytes with no Node built-in and no host locale call.`);

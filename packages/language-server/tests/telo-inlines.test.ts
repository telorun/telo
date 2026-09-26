import { expect, it } from "vitest";
// @ts-expect-error — a plain ESM script with no declarations.
import { verifyInlines } from "../../../scripts/check-changeset-status.mjs";

const PACKAGE = new URL("..", import.meta.url).pathname;

// The build holds `teloInlines` to exactly the workspace packages the bundle's
// metafile attributes inputs to: third-party code and the package's own sources
// are not inlines, and a declared name absent from the bundle is as wrong as an
// inlined one missing from the list.
it("compares teloInlines with the workspace packages a metafile holds", () => {
  const metafile = {
    inputs: Object.fromEntries(
      [
        "src/index.ts",
        "../editor-protocol/src/index.ts",
        "../ide-support/src/index.ts",
        "../../analyzer/nodejs/src/index.ts",
        "../../sdk/nodejs/src/index.ts",
        "../../templating/nodejs/src/index.ts",
        "../../node_modules/.pnpm/yaml@2.8.3/node_modules/yaml/dist/index.js",
      ].map((input) => [input, {}]),
    ),
  };
  expect(verifyInlines(PACKAGE, metafile)).toEqual([
    "@telorun/glob is listed in @telorun/language-server's teloInlines but the bundle holds none of it.",
  ]);
  metafile.inputs["../glob/nodejs/src/index.ts"] = {};
  metafile.inputs["../debug-wire/src/index.ts"] = {};
  expect(verifyInlines(PACKAGE, metafile)).toEqual([
    "@telorun/debug-wire is inlined into the bundle but missing from @telorun/language-server's teloInlines.",
  ]);
});

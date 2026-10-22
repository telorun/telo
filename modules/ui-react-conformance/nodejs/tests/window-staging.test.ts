import type { BrowserEntryFiles } from "@telorun/sdk";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSets } from "../src/control-sets.js";
import { stageWindow } from "../src/window-staging.js";

// The real path: a Windows temp directory under an 8.3 short name (`RUNNER~1`)
// becomes `%7E` in a file URL, which the test runner's loader cannot resolve.
const work = await realpath(await mkdtemp(join(tmpdir(), "telo-ui-react-conformance-test-")));
afterAll(() => rm(work, { recursive: true, force: true }));

/** A built entry: its module and siblings written under `build`. */
async function entry(build: string, path: string, files: Record<string, string>): Promise<BrowserEntryFiles> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, build, name)), { recursive: true });
    await writeFile(join(work, build, name), text);
  }
  const url = (name: string) => pathToFileURL(join(work, build, name)).href;
  return {
    specifier: path,
    file: url(path),
    siblings: Object.keys(files).filter((name) => name !== path).map(url),
    digest: `${build}/${path}`,
    external: [],
    exports: [],
  };
}

const chunk = { "browser/chunk.js": "export const react = { name: 'the one React' };\n" };
const vendor = (path: string) => entry("vendor", path, { [path]: `import { react } from "./chunk.js";\nexport default react;\n`, ...chunk });
const set = (name: string, source: string) => entry(name, "browser/set.js", { "browser/set.js": source });

describe("a check's window", () => {
  it("binds the renderer and every set to one React, and supplies a set only its generation's specifiers", async () => {
    const staged = await stageWindow(
      {
        react: await vendor("browser/react.js"),
        jsxRuntime: await vendor("browser/react-jsx-runtime.js"),
        reactDom: await vendor("browser/react-dom.js"),
        reactDomClient: await vendor("browser/react-dom-client.js"),
        renderer: await entry("renderer", "browser/renderer.js", {
          "browser/renderer.js": `import React from "react";\nimport client from "react-dom/client";\nexport const both = [React, client];\n`,
        }),
        sets: [
          await set("supplied", `import React from "react";\nimport runtime from "react/jsx-runtime";\nimport dom from "react-dom";\nexport const Select = () => [React, runtime, dom];\n`),
          await set("host", `import "@telorun/ui-react";\nexport const Select = () => null;\n`),
          await set("client", `import "react-dom/client";\nexport const Select = () => null;\n`),
        ],
      },
      join(work, "stage"),
    );
    const { both } = (await import(staged.renderer)) as { both: unknown[] };
    const sets = [
      { owner: "supplied", files: {} as BrowserEntryFiles, implements: ["Select"] },
      { owner: "host", files: {} as BrowserEntryFiles, implements: ["Select"] },
      { owner: "client", files: {} as BrowserEntryFiles, implements: ["Select"] },
    ];
    const loaded = await loadSets(sets, staged.sets);
    const one = both[0];
    expect(both).toEqual([one, one]);
    expect((loaded[0].module!.Select as () => unknown[])()).toEqual([one, one, one]);
    expect((loaded[0].module!.Select as () => unknown[])().every((react) => react === one)).toBe(true);
    expect(loaded.slice(1).map((each) => each.failure?.startsWith("its entry did not load:"))).toEqual([true, true]);
  });
});

import { DESIGN_TOKENS } from "@telorun/ui";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokenProperty } from "../../../ui-react/nodejs/src/contract/token-property.js";

const MODULE = fileURLToPath(new URL("../..", import.meta.url));
const CONTROLS = join(MODULE, "nodejs/src/controls");
const read = (path: string) => readFileSync(path, "utf8");

/** What the browser entry may import at run time: the page's React, the primitives, the icons and its own files. */
const RUNTIME = new Set(["react", "react-dom", "radix-ui", "lucide-react"]);

describe("the browser entry", () => {
  it("reaches ui-react only for the contract's types", () => {
    const strays: string[] = [];
    for (const file of readdirSync(CONTROLS).filter((name) => /\.tsx?$/.test(name))) {
      for (const [statement, type, specifier] of read(join(CONTROLS, file)).matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
        const own = specifier.startsWith("./");
        const contract = specifier.includes("/ui-react/nodejs/src/contract/") && type !== undefined;
        if (!own && !contract && !RUNTIME.has(specifier)) strays.push(`${file}: ${statement}`);
      }
    }
    expect(strays).toEqual([]);
  });
});

describe("the --telo- custom properties", () => {
  it("are the design tokens' only", () => {
    const tokens = new Set(DESIGN_TOKENS.map(tokenProperty));
    const sheets = [join(MODULE, "themes/radix-theme.css"), join(CONTROLS, "controls.css")];
    const strays = sheets.flatMap((sheet) =>
      [...new Set([...read(sheet).matchAll(/--telo-[\w-]+/g)].map(([property]) => property))]
        .filter((property) => !tokens.has(property))
        .map((property) => `${sheet}: ${property}`),
    );
    expect(strays).toEqual([]);
  });
});

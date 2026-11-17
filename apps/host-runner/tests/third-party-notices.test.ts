import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noticesFromMetafile } from "../scripts/third-party-notices.mjs";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-notices-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function pkg(dir: string, manifest: Record<string, unknown>, license?: string): string {
  const full = path.join(root, dir);
  fs.mkdirSync(path.join(full, "src"), { recursive: true });
  fs.writeFileSync(path.join(full, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(full, "src", "index.js"), "");
  if (license !== undefined) fs.writeFileSync(path.join(full, "LICENSE"), license);
  return `${dir}/src/index.js`;
}

const metafile = (...inputs: string[]) => ({ inputs: Object.fromEntries(inputs.map((i) => [i, {}])) });

describe("THIRD_PARTY_NOTICES", () => {
  it("holds the license text of each MIT package in the bundle and nothing else", () => {
    const text = noticesFromMetafile(
      metafile(
        pkg("node_modules/left", { name: "left", version: "1.0.0", license: "MIT" }, "MIT left text"),
        pkg("node_modules/left-more", { name: "left", version: "1.0.0", license: "MIT" }),
        pkg("node_modules/either", { name: "either", version: "2.0.0", license: "(MIT OR Apache-2.0)" }, "either text"),
        pkg("node_modules/isc", { name: "isc", version: "3.0.0", license: "ISC" }, "ISC text"),
        pkg("apps/runner", { name: "runner", version: "1.0.0", license: "SEE LICENSE IN LICENSE" }, "restricted"),
      ),
      root,
    );
    expect(text).toContain("left@1.0.0\n\nMIT left text");
    expect(text).toContain("either@2.0.0\n\neither text");
    expect(text).not.toContain("ISC text");
    expect(text).not.toContain("restricted");
    expect(text.match(/left@1\.0\.0/g)).toHaveLength(1);
  });

  it("reads a workspace package's license from its unit directory, never the repository root", () => {
    fs.writeFileSync(path.join(root, "LICENSE"), "root restricted license");
    fs.mkdirSync(path.join(root, "kernel"));
    fs.writeFileSync(path.join(root, "kernel", "LICENSE"), "kernel MIT text");
    const input = pkg("kernel/nodejs", { name: "@telorun/kernel", version: "1.0.0", license: "MIT" });
    expect(noticesFromMetafile(metafile(input), root)).toContain("kernel MIT text");

    fs.rmSync(path.join(root, "kernel", "LICENSE"));
    expect(() => noticesFromMetafile(metafile(input), root)).toThrow(/hold no LICENSE file[\s\S]*@telorun\/kernel@1\.0\.0/);
  });

  it("takes a license from the README, then from a reviewed supplement, for a package with no license file", () => {
    const readme = (dir: string, text: string) => fs.writeFileSync(path.join(root, dir, "README.md"), text);
    const inReadme = pkg("node_modules/readme", { name: "readme", version: "1.0.0", license: "MIT" });
    readme(
      "node_modules/readme",
      "## License\n\nCopyright (c) 2014 Someone\n\nPermission is hereby granted, free of charge, to any person\nDEALINGS IN THE SOFTWARE.\n",
    );
    const bare = pkg("node_modules/bare", { name: "bare", version: "1.0.0", license: "MIT" });
    expect(noticesFromMetafile(metafile(inReadme), root)).toContain("Copyright (c) 2014 Someone\n\nPermission is hereby granted");
    expect(() => noticesFromMetafile(metafile(bare), root)).toThrow(/bare@1\.0\.0/);
    expect(noticesFromMetafile(metafile(bare), root, root, { bare: "Copyright (c) Bare Author" })).toContain(
      "Copyright (c) Bare Author\n\nPermission is hereby granted",
    );
  });

  it("fails, naming the package, when an MIT package has no license text", () => {
    const input = pkg("node_modules/bare", { name: "bare", version: "0.1.0", license: "MIT" });
    expect(() => noticesFromMetafile(metafile(input), root)).toThrow(/hold no LICENSE file[\s\S]*bare@0\.1\.0/);
  });
});

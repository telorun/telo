import type { BrowserEntryFiles } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The built entries a check's window loads: the page's one React, the renderer, and each control set's entry. */
export interface WindowEntries {
  react: BrowserEntryFiles;
  jsxRuntime: BrowserEntryFiles;
  reactDom: BrowserEntryFiles;
  reactDomClient: BrowserEntryFiles;
  renderer: BrowserEntryFiles;
  sets: BrowserEntryFiles[];
}

/** Where each staged entry's module is, as a URL an `import()` takes. */
export interface StagedWindow {
  react: string;
  reactDomClient: string;
  renderer: string;
  /** In the order of {@link WindowEntries.sets}. */
  sets: string[];
}

const filesOf = (entry: BrowserEntryFiles) => [entry.file, ...entry.siblings].map((uri) => fileURLToPath(uri));

function commonDirectory(files: string[]): string {
  let common = dirname(files[0]);
  for (const file of files.slice(1)) {
    while (common !== dirname(common) && !file.startsWith(common + sep)) common = dirname(common);
  }
  return common;
}

/**
 * Copy entries into `area`, keeping together the entries that share a file —
 * entries of one build importing one chunk must import ONE copy of it, or each
 * would hold its own React. Each group lands in a directory named by its
 * entries' digests, at the paths its files have relative to one another.
 * Answers where each entry's own module landed.
 */
async function stageEntries(entries: BrowserEntryFiles[], area: string): Promise<string[]> {
  const group = entries.map((_, index) => index);
  const find = (index: number): number => (group[index] === index ? index : (group[index] = find(group[index])));
  const owner = new Map<string, number>();
  entries.forEach((entry, index) => {
    for (const file of filesOf(entry)) {
      const first = owner.get(file);
      if (first === undefined) owner.set(file, index);
      else group[find(index)] = find(first);
    }
  });
  const members = new Map<number, number[]>();
  entries.forEach((_, index) => members.set(find(index), [...(members.get(find(index)) ?? []), index]));
  const staged: string[] = [];
  for (const indices of members.values()) {
    const files = [...new Set(indices.flatMap((index) => filesOf(entries[index])))];
    const base = commonDirectory(files);
    const key = createHash("sha256")
      .update([...new Set(indices.map((index) => entries[index].digest))].sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    const directory = join(area, key);
    for (const file of files) {
      const target = join(directory, relative(base, file));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
    }
    for (const index of indices) staged[index] = join(directory, relative(base, fileURLToPath(entries[index].file)));
  }
  return staged;
}

/** A package under `node_modules/<name>` whose subpaths re-export staged modules. */
async function generatedPackage(area: string, name: string, subpaths: Record<string, string>): Promise<void> {
  const directory = join(area, "node_modules", name);
  await mkdir(directory, { recursive: true });
  const exports: Record<string, string> = {};
  for (const [subpath, module] of Object.entries(subpaths)) {
    const file = subpath === "." ? "index.js" : `${subpath.slice(2)}.js`;
    const url = JSON.stringify(pathToFileURL(module).href);
    await writeFile(join(directory, file), `export * from ${url};\nexport { default } from ${url};\n`);
    exports[subpath] = `./${file}`;
  }
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, type: "module", exports }, null, 2)}\n`);
}

/**
 * Stage a window's entries under `root`: the four React entries once, the
 * renderer beside packages supplying `react`, `react/jsx-runtime`, `react-dom`
 * and `react-dom/client`, and the control sets beside packages supplying exactly
 * what their generation supplies — `react`, `react/jsx-runtime`, `react-dom`.
 * Every package re-exports the one staged React, so the renderer and every set
 * bind one React.
 */
export async function stageWindow(entries: WindowEntries, root: string): Promise<StagedWindow> {
  const [react, jsxRuntime, reactDom, reactDomClient] = await stageEntries(
    [entries.react, entries.jsxRuntime, entries.reactDom, entries.reactDomClient],
    join(root, "vendor"),
  );
  const rendererArea = join(root, "renderer");
  const controlsArea = join(root, "controls");
  for (const [area, client] of [
    [rendererArea, true],
    [controlsArea, false],
  ] as const) {
    await generatedPackage(area, "react", { ".": react, "./jsx-runtime": jsxRuntime });
    await generatedPackage(area, "react-dom", { ".": reactDom, ...(client ? { "./client": reactDomClient } : {}) });
  }
  const [renderer] = await stageEntries([entries.renderer], rendererArea);
  const sets = entries.sets.length === 0 ? [] : await stageEntries(entries.sets, controlsArea);
  const url = (file: string) => pathToFileURL(file).href;
  return { react: url(react), reactDomClient: url(reactDomClient), renderer: url(renderer), sets: sets.map(url) };
}

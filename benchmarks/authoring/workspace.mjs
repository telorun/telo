// The directory an agent works in: the prose, and for a change task the repo's own
// implementation of the side. Also how much the agent wrote into it.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TASKS, leadIntake, repoRoot } from "./tasks.mjs";

const NODE_TSCONFIG = {
  compilerOptions: {
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2022",
    strict: true,
    skipLibCheck: true,
    types: ["node"],
    rootDir: "src",
    outDir: "dist",
  },
  include: ["src"],
};

function nodeProject() {
  const source = JSON.parse(readFileSync(join(leadIntake, "package.json"), "utf8"));
  return {
    name: "lead-intake",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { build: "tsc -p tsconfig.json", start: "node dist/server.js" },
    dependencies: source.dependencies,
    devDependencies: source.devDependencies,
  };
}

// The repo's implementation imports modules by relative path; a workspace outside the repo imports
// the published artifact of the same version instead.
function publishedImport(name) {
  const module = readFileSync(join(repoRoot, "modules", name, "telo.yaml"), "utf8");
  const version = /^ {2}version: "?([^"\s]+)"?/m.exec(module)?.[1];
  if (!version) throw new Error(`modules/${name}/telo.yaml declares no version`);
  return `oci://ghcr.io/telorun/${name}@${version}`;
}

function resolvedImports(manifest, importOf) {
  return manifest.replace(/(\s)\.\.\/\.\.\/\.\.\/modules\/([a-z0-9-]+)(\s)/g, (_, before, name, after) => `${before}${importOf(name)}${after}`);
}

// `importOf` names where a module is imported from: its published artifact by default. A version
// that has not been published yet (a release PR) is not reachable, so a test passes the working copy.
export function prepareWorkspace(task, side, directory, { importOf = publishedImport } = {}) {
  mkdirSync(directory, { recursive: true });
  cpSync(join(leadIntake, "CONTRACT.md"), join(directory, "CONTRACT.md"));
  if (!TASKS[task].change) return;
  cpSync(join(TASKS[task].directory, "TASK.md"), join(directory, "TASK.md"));
  if (side === "telo") {
    for (const file of ["light.yaml", "medium.yaml", "heavy.yaml"]) cpSync(join(leadIntake, "telo", file), join(directory, file));
    writeFileSync(join(directory, "telo.yaml"), resolvedImports(readFileSync(join(leadIntake, "telo/telo.yaml"), "utf8"), importOf));
  } else {
    cpSync(join(leadIntake, "node/src"), join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "package.json"), `${JSON.stringify(nodeProject(), null, 2)}\n`);
    writeFileSync(join(directory, "tsconfig.json"), `${JSON.stringify(NODE_TSCONFIG, null, 2)}\n`);
  }
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".telo", ".git"]);
const SKIPPED_FILES = new Set(["package-lock.json", "spans.jsonl", "CLAUDE.md"]);
const MAX_FILE_BYTES = 1024 * 1024;

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(path);
    } else if (entry.isFile() && !SKIPPED_FILES.has(entry.name) && !entry.name.endsWith(".db") && statSync(path).size <= MAX_FILE_BYTES) {
      yield path;
    }
  }
}

function linesOf(path) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return [];
  return bytes.toString("utf8").split("\n").filter((line) => line.trim() !== "");
}

// The non-blank lines in the final tree that the starting tree did not hold (a multiset
// difference per file), so a rewritten file counts its new lines and an untouched one counts none.
export function linesWritten(startDirectory, finalDirectory) {
  let total = 0;
  for (const path of sourceFiles(finalDirectory)) {
    const before = join(startDirectory, relative(finalDirectory, path));
    const remaining = new Map();
    if (existsSync(before)) for (const line of linesOf(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
    for (const line of linesOf(path)) {
      const left = remaining.get(line) ?? 0;
      if (left > 0) remaining.set(line, left - 1);
      else total++;
    }
  }
  return total;
}

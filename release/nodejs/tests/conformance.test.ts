/**
 * Runs the twin-conformance vectors (`release/conformance/`): the same rows
 * `release/rust/tests/conformance.rs` answers, each answered here and compared
 * whole with what the row records.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  EMPTY_LEDGER,
  SHIPPED_ADAPTERS,
  WORKSPACE_FILENAME,
  parseFragment,
  parseLedger,
  planRelease,
  prependChangelogRelease,
  readReleaseMarker,
  readVersionAt,
  recordRelease,
  renderChangelogRelease,
  resolveUnits,
  serializeFragment,
  serializeLedger,
  stampLockedCrateVersion,
  writeVersionAt,
  type FragmentKind,
  type UnitEvidence,
  type UnitLayers,
  type WorkspaceTree,
} from "../src/index.js";
import { closureFromLock, closureFromMetadata, linksArtifact } from "../src/adapters/cargo-closure.js";
import { digestFileSet, type FileSetEntry } from "../src/node/files-digest.js";
import { commit, host, run, tempRepo } from "./node/fixture.js";

const vectors = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../conformance");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(vectors, name), "utf8"));
const registry = new AdapterRegistry(SHIPPED_ADAPTERS);

function attempt<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function tree(files: Record<string, string>): WorkspaceTree {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const directories = [...dirs].sort();
  return {
    directories: () => directories,
    filesUnder: (dir) =>
      Object.keys(files)
        .filter((f) => dir === "" || f.startsWith(`${dir}/`))
        .map((f) => (dir === "" ? f : f.slice(dir.length + 1)))
        .sort(),
    readFile: (p) => files[p],
  };
}

function layersOf(raw: Record<string, unknown> | undefined): UnitLayers {
  const ecosystems: Record<string, never> = {};
  let payload: string | undefined;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === "payload") payload = value as string;
    else ecosystems[key] = value as never;
  }
  return { ecosystems, ...(payload !== undefined ? { payload } : {}) };
}

describe("release conformance vectors", () => {
  it.each(read("markers.json").map((row: { name: string }) => [row.name, row]))("marker %s", (_name, row) => {
    const read = readReleaseMarker(row.files[WORKSPACE_FILENAME], WORKSPACE_FILENAME, SHIPPED_ADAPTERS, {
      ...(row.ecosystemHosts ? { ecosystemHosts: row.ecosystemHosts } : {}),
    });
    const diagnostics = read.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, path: d.path }));
    let units: unknown = null;
    if (read.release) {
      const resolution = resolveUnits(read.release, tree(row.files), registry);
      for (const d of resolution.diagnostics) diagnostics.push({ code: d.code, severity: d.severity, message: d.message, path: d.path });
      units = resolution.units.map((u) => ({
        key: u.key,
        dir: u.dir,
        anchors: u.anchors.map((a) => ({
          ecosystem: a.ecosystem,
          anchor: a.anchor,
          dir: a.dir,
          name: a.package.name ?? null,
          contributesLayer: a.package.contributesLayer,
          versionFiles: a.package.versionFiles ?? [],
          settings: a.settings,
        })),
        version: u.version.pointer ? `${u.version.file}#${u.version.pointer}` : u.version.file,
        versionLocations: u.versionLocations.map((l) => (l.pointer ? `${l.file}#${l.pointer}` : l.file)),
        payload: u.payload ?? null,
        metafile: u.metafile ?? null,
        ignore: u.ignore,
        maxBump: u.maxBump,
        group: u.group ?? null,
      }));
    }
    expect({ diagnostics, units }).toEqual(row.expected);
  });

  it.each(read("plans.json").map((row: { name: string }) => [row.name, row]))("plan %s", (_name, row) => {
    const evidence: UnitEvidence[] = row.units.map((u: Record<string, unknown>) => ({
      ...u,
      layers: layersOf(u.layers as Record<string, unknown>),
      inlines: new Map(Object.entries((u.inlines as Record<string, string[]>) ?? {})),
    }));
    const ledger = row.ledger === null ? EMPTY_LEDGER : parseLedger(row.ledger, "ledger.yaml");
    const fragments = row.fragments.map((f: { text: string; source: string }) => parseFragment(f.text, f.source));
    const groups = new Map<string, string[]>(Object.entries(row.groups ?? {}));
    const answer = attempt(() => {
      const plan = planRelease({ units: evidence, ledger, fragments, groups }, row.candidate ? { candidate: row.candidate } : {});
      const readings = new Map(evidence.map((u) => [u.key, { layers: u.layers, ...(u.registry ? { registry: u.registry } : {}) }]));
      return {
        plan: {
          units: plan.units.map((p) => ({ ...p, group: p.group ?? null })),
          fragments: plan.fragments,
          candidate: plan.candidate ?? null,
          diagnostics: plan.diagnostics,
        },
        recorded: serializeLedger(recordRelease(ledger, plan, readings)),
      };
    });
    expect(answer).toEqual(row.expected);
  });

  it.each(read("digests.json").map((row: { name: string }) => [row.name, row]))("digest %s", (_name, row) => {
    const entries: FileSetEntry[] = row.entries.map((e: Record<string, string | boolean>) =>
      "link" in e
        ? { path: e.path as string, link: e.link as string }
        : {
            path: e.path as string,
            content: "base64" in e ? Buffer.from(e.base64 as string, "base64") : Buffer.from(e.text as string, "utf8"),
            ...(e.executable ? { executable: true } : {}),
          },
    );
    expect(attempt(() => ({ digest: digestFileSet(entries) }))).toEqual(row.expected);
  });

  const yaml = read("yaml.json");
  it.each(yaml.fragments.map((row: { name: string }) => [row.name, row]))("fragment written %s", (_name, row) => {
    expect({ text: serializeFragment(new Map(Object.entries(row.units)) as Map<string, FragmentKind>, row.body) }).toEqual(row.expected);
  });
  it.each(yaml.ledgers.map((row: { name: string }) => [row.name, row]))("ledger %s", (_name, row) => {
    expect(attempt(() => ({ serialized: serializeLedger(parseLedger(row.text, "ledger.yaml")) }))).toEqual(row.expected);
  });
  it.each(yaml.fragmentTexts.map((row: { name: string }) => [row.name, row]))("fragment read %s", (_name, row) => {
    expect(
      attempt(() => {
        const fragment = parseFragment(row.text, row.source);
        return { units: Object.fromEntries(fragment.units), body: fragment.body };
      }),
    ).toEqual(row.expected);
  });

  const files = read("version-files.json");
  it.each(files.versionFiles.map((row: { name: string }) => [row.name, row]))("version file %s", (_name, row) => {
    const location = { file: row.file, ...(row.pointer ? { pointer: row.pointer } : {}) };
    const where = row.pointer ? `${row.file}#${row.pointer}` : row.file;
    expect({
      read: attempt(() => ({ value: readVersionAt(location, row.text, where, registry) ?? null })),
      write: attempt(() => ({ text: writeVersionAt(location, row.text, row.version, where, registry) })),
    }).toEqual(row.expected);
  });
  it.each(files.lockfiles.map((row: { name: string }) => [row.name, row]))("lockfile %s", (_name, row) => {
    expect(attempt(() => ({ text: stampLockedCrateVersion(row.text, row.crate, row.version, "Cargo.lock") ?? null }))).toEqual(row.expected);
  });

  const closures = read("cargo-closures.json");
  it.each(closures.metadata.map((row: { name: string }) => [row.name, row]))("cargo closure from metadata %s", (_name, row) => {
    expect(
      attempt(() => {
        const root = row.metadata.packages.find((pkg: { id: string }) => pkg.id === row.root);
        if (!root) throw new Error(`cargo metadata lists no package '${row.root}'.`);
        return { entry: linksArtifact(root.targets) ? closureFromMetadata(row.metadata, row.root) : null };
      }),
    ).toEqual(row.expected);
  });
  it.each(closures.locks.map((row: { name: string }) => [row.name, row]))("cargo closure from a lockfile %s", (_name, row) => {
    expect(
      attempt(() => ({ entry: closureFromLock(row.lock, row.manifest, row.root, row.members, "fx-app-2.0.0.crate/Cargo.lock") })),
    ).toEqual(row.expected);
  });

  it.each(read("changelogs.json").map((row: { name: string }) => [row.name, row]))("changelog %s", (_name, row) => {
    expect({ text: prependChangelogRelease(row.existing ?? undefined, renderChangelogRelease(row)) }).toEqual(row.expected);
  });

  it.each(read("commands.json").map((row: { name: string }) => [row.name, row]))("commands %s", async (_name, row) => {
    const root = tempRepo(row.files);
    try {
      const { host: h, recorded } = host();
      const answers: unknown[] = [];
      for (const step of row.steps as { args: string[] }[]) {
        const before = recorded.payloads.length;
        const { exitCode } = await run(h, recorded, root, step.args);
        answers.push({ exitCode, payload: recorded.payloads.length > before ? recorded.payloads[recorded.payloads.length - 1] : null });
        commit(root, step.args.join(" "));
      }
      expect(answers).toEqual(row.steps.map((step: { expected: unknown }) => step.expected));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

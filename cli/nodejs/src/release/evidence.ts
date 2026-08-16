/**
 * Collecting what the planner needs: one `ModuleEvidence` per module.
 *
 * Three separate readings, because the plan asks three separate questions:
 *
 * - **The payload digest** — built through the shared `ModulePayloadBuilder`, so
 *   the number recorded here is the number `telo publish` computes against the
 *   registry. That equality is the whole point of the ledger.
 * - **The edge graph** — from the build's own metafile (which module's source
 *   got inlined into whose artifact) and from in-repo relative `imports:`. A
 *   declared-dependency graph cannot see `--external`, so `@telorun/sdk` —
 *   declared by 54 modules, inlined by none — would bump the entire standard
 *   library on every SDK change.
 * - **Own changed files** — a git diff, path-scoped. It used to decide the
 *   version, which is why its guesswork had to be sound; here it decides only
 *   whether a changelog line is requested.
 */

import {
  MANIFEST_LAYER,
  layerDigestKey,
  type LayerDigests,
  type ModuleEvidence,
  type ModuleKey,
} from "@telorun/analyzer";
import { computeFilesIntegrity } from "@telorun/kernel";
import { selectByPatterns } from "@telorun/glob";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModulePayloadBuilder, type ModulePayload } from "../bundle/module-payload.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

export interface EvidenceOptions {
  /** `oci://host/org` — the base each module's destination derives from. */
  readonly registry: string;
  /** Git ref the changed-files reading diffs against. */
  readonly baseRef: string;
  /** Called before each module is built, so a long batch shows progress. */
  readonly onModule?: (module: DiscoveredModule, index: number, total: number) => void;
}

/**
 * A module's publish destination: the registry base plus its own directory name.
 *
 * Identity is the ref, never `metadata.name` — this is the same rule the release
 * job has always applied, lifted out of a shell script.
 *
 * This is the ROOT destination, which is a policy rather than a derivation:
 * nothing in the graph can say which repo a module publishes to. The payload
 * builder derives a SIBLING's from it instead of re-applying this rule, so the
 * ref an artifact carries and the destination its dependency is pushed to are
 * the same string by construction.
 */
export function destinationFor(registry: string, module: DiscoveredModule): string {
  return `${registry.replace(/\/+$/, "")}/${path.basename(module.dir)}`;
}

/**
 * A built payload reduced to the per-layer digest map the ledger records.
 *
 * ONE function, because there are two write paths into the ledger — `apply`
 * recording what it is about to publish, and `verify --write` re-recording what
 * the registry actually serves — and the gates only work if they produce the
 * same map. Two hand-built copies that drifted would make `verify --write`
 * record numbers `check` cannot reproduce, and every module would then report
 * permanent phantom drift: the exact failure the ledger's "both gates compute
 * the same number" premise rests on not happening.
 */
export async function digestPayload(payload: ModulePayload): Promise<LayerDigests> {
  // The manifest is not one of `partitionLayers`' layers — the transport writes
  // it as its own — but it is the layer that changes when a dependency's version
  // or pin moves, which is most of what propagation is about.
  const layers: Record<string, string> = {
    [MANIFEST_LAYER]: await computeFilesIntegrity([
      { name: MANIFEST_LAYER, content: Buffer.from(payload.manifest, "utf8") },
    ]),
  };
  for (const layer of payload.layers) {
    layers[layerDigestKey(layer.role, layer.selector)] = await computeFilesIntegrity(layer.files);
  }
  return layers;
}

export async function collectEvidence(
  workspace: Workspace,
  options: EvidenceOptions,
): Promise<ModuleEvidence[]> {
  const byDir = new Map(workspace.modules.map((module) => [path.resolve(module.dir), module]));
  const changed = changedModules(workspace, options.baseRef);
  const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workspace.root, ".telo") });

  const evidence: ModuleEvidence[] = [];
  for (const [index, module] of workspace.modules.entries()) {
    options.onModule?.(module, index, workspace.modules.length);
    evidence.push(
      module.artifactKind === "image"
        ? await imageEvidence(module, changed)
        : await registryEvidence(workspace, module, byDir, builder, options, changed),
    );
  }
  return evidence;
}

/**
 * A registry artifact module: the layers `telo publish` builds, digested.
 */
async function registryEvidence(
  workspace: Workspace,
  module: DiscoveredModule,
  byDir: ReadonlyMap<string, DiscoveredModule>,
  builder: ModulePayloadBuilder,
  options: EvidenceOptions,
  changed: ReadonlySet<ModuleKey>,
): Promise<ModuleEvidence> {
  const payload = await builder.payload(
    module.manifestPath,
    destinationFor(options.registry, module),
  );

  return {
    key: module.key,
    name: module.name,
    version: module.version,
    artifactKind: "registry",
    layers: await digestPayload(payload),
    inlines: attributeInputs(workspace, payload.buildInputs, module, byDir),
    imports: payload.relativeImports
      .map((entry) => byDir.get(path.resolve(path.dirname(entry.manifestPath)))?.key)
      .filter((key): key is ModuleKey => key !== undefined && key !== module.key),
    ownFilesChanged: changed.has(module.key),
  };
}

/**
 * An image module: the file set its Docker ignore file defines, digested.
 *
 * The ignore file is already the authored statement of what the image contains,
 * so it is read rather than the `COPY` directives parsed. Without a digest here
 * the demoted changed-files rule would be authoritative again for a third of the
 * set — which is precisely the guesswork this design moves off the critical path.
 *
 * The base image is deliberately outside it: a kernel change alters `apps/hub`'s
 * image while this digest does not move. That exposure is closed elsewhere —
 * every app image publishes `:latest` and `:sha-<short>` on each push, so the
 * change reaches the deployed app regardless, and the immutable `:<version>` tag
 * is what a version move is for.
 */
async function imageEvidence(
  module: DiscoveredModule,
  changed: ReadonlySet<ModuleKey>,
): Promise<ModuleEvidence> {
  return {
    key: module.key,
    name: module.name,
    version: module.version,
    artifactKind: "image",
    layers: { image: await imageDigest(module) },
    inlines: new Map(),
    imports: [],
    ownFilesChanged: changed.has(module.key),
  };
}

/** BuildKit's per-Dockerfile ignore file, then the classic one. Both image
 *  modules here carry the former, and looking for only `.dockerignore` would
 *  digest every excluded file in both. */
const DOCKERIGNORE_NAMES = ["Dockerfile.dockerignore", ".dockerignore"];

export async function imageDigest(module: DiscoveredModule): Promise<string> {
  const ignoreFile = DOCKERIGNORE_NAMES.map((name) => path.join(module.dir, name)).find((file) =>
    fs.existsSync(file),
  );
  const ignored = ignoreFile
    ? fs
        .readFileSync(ignoreFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
    : [];

  // An ignore file EXCLUDES, so it goes in `exclude:` rather than being read as
  // a selector — `*` followed by `!*.yaml` means "nothing but the YAML", and
  // treating those as includes would digest exactly the files Docker drops.
  // `exclude` shares the same last-match-wins engine, so the re-include works.
  //
  // The same digest primitive the artifact layers use, so "did this module's
  // payload change?" is one question with one answer regardless of which of the
  // two file sets stands behind it.
  const files = selectByPatterns(listFiles(module.dir), ["**"], {
    applyDefaultIgnore: false,
    exclude: ignored,
  });
  return computeFilesIntegrity(
    [...files].sort().map((file) => ({
      name: file,
      content: fs.readFileSync(path.join(module.dir, file)),
    })),
  );
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".telo") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found;
}

/**
 * Attribute each build input to the workspace module that owns it.
 *
 * A module's own sources are excluded — they are covered by its digest and by
 * the changed-files reading, and listing them as an inline edge would make every
 * module inline itself. An input under no module (a third-party package, a
 * changesets-owned library) is deliberately not attributed: that is the
 * *unattributed* case, reported rather than papered over.
 */
function attributeInputs(
  workspace: Workspace,
  inputs: readonly string[],
  module: DiscoveredModule,
  byDir: ReadonlyMap<string, DiscoveredModule>,
): Map<ModuleKey, string[]> {
  const owners = new Map<ModuleKey, string[]>();
  for (const input of inputs) {
    const owner = ownerOf(path.resolve(input), byDir);
    if (!owner || owner.key === module.key) continue;
    const list = owners.get(owner.key);
    const relative = path.relative(workspace.root, input).split(path.sep).join("/");
    if (list) list.push(relative);
    else owners.set(owner.key, [relative]);
  }
  for (const files of owners.values()) files.sort();
  return owners;
}

/** The nearest enclosing module directory, by walking up. Nearest rather than
 *  any, so a nested module is credited to itself. */
function ownerOf(
  file: string,
  byDir: ReadonlyMap<string, DiscoveredModule>,
): DiscoveredModule | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const owner = byDir.get(dir);
    if (owner) return owner;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Paths under a module that never reach its artifact, so editing one is not a
 *  semantic change worth a changelog line. Kept deliberately short: this rule no
 *  longer decides a version, so a false positive costs one sentence and the old
 *  per-language guesswork bought nothing. */
const NON_ARTIFACT_PATHS = [/^docs\//, /^plans\//, /^tests\//, /^README\.md$/, /^CHANGELOG\.md$/];

/**
 * Modules with a change of their own on this branch.
 *
 * No merge base — a shallow clone, a fresh repo — means the reading cannot be
 * taken, and guessing would ask for a changelog entry at random. The digest is
 * unaffected: it compares against the ledger, not against a ref, which is why it
 * needs no merge base in the first place.
 */
function changedModules(workspace: Workspace, baseRef: string): Set<ModuleKey> {
  let diff: string;
  try {
    diff = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
      cwd: workspace.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Set();
  }

  const changed = new Set<ModuleKey>();
  for (const file of diff.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const module = workspace.modules.find((candidate) => file.startsWith(`${candidate.key}/`));
    if (!module) continue;
    const rest = file.slice(module.key.length + 1);
    if (NON_ARTIFACT_PATHS.some((pattern) => pattern.test(rest))) continue;
    changed.add(module.key);
  }
  return changed;
}

/**
 * Building a module's published payload — the one computation both gates run.
 *
 * `telo publish` pushes it and `telo release` digests it, and they have to be
 * the same bytes or the ledger's number and the registry's number are answers to
 * different questions. So there is one builder, and the publish command consumes
 * it rather than carrying its own copy of the transform.
 *
 * ## What makes the bytes a pure function of the commit
 *
 * Three inputs used to leak in, and each is closed here:
 *
 * 1. **Pins were discovered, not authored.** Publish fetched each remote
 *    dependency's published `telo.yaml` to derive its hash, best-effort — so one
 *    commit produced different manifest bytes depending on network reachability.
 *    An author's pin is now the input: `telo install` / `telo upgrade` write it,
 *    and an unpinned remote import is refused here rather than resolved.
 * 2. **Re-serialization was conditional** on at least one pin having been
 *    written, so the same manifest serialized two ways depending on its own
 *    content. It is unconditional now.
 * 3. **A sibling's pin came from the registry.** An in-repo sibling is on disk,
 *    so its published manifest is *derived* — recursively, through this same
 *    builder — which is what lets a whole release batch be planned offline, with
 *    post-bump versions the registry has never seen.
 * 4. **The derived manifest was not the published one.** The `layers:` index was
 *    injected during the push, so what this builder returned was a document no
 *    registry ever holds — and a sibling pin, being a hash of it, named bytes
 *    that do not exist. The index is written here now, which is what makes
 *    `publishedManifest()` true to its name and requires layer framing to be a
 *    pure function of the files it covers.
 *
 * The publish destination stays an input, because canonicalization writes it
 * into the manifest. It is not derivable, so the ledger records which base its
 * digests were taken against.
 */

import {
  collectModuleFileClaims,
  DEFAULT_MANIFEST_FILENAME,
  sha256Base64Url,
  splitIntegrity,
  type ArtifactSelector,
  type LayerRole,
} from "@telorun/analyzer";
import {
  buildControllerBundle,
  defaultTransportRegistry,
  injectLayerIndex,
  readOwnerManifest,
  type PayloadFile,
  type SiblingLibrary,
} from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import { findModuleDoc, importSourceRefs } from "../commands/manifest-imports.js";
import { expandAndInlineIncludes, readAssetPatterns, readFilesPatterns } from "./manifest-text.js";
import { partitionLayers, type Partition } from "./partition-layers.js";
import { assertWithinModule, selectFiles } from "./select-files.js";

/** A layer built from a working copy: what publish pushes and what the release
 *  ledger digests. Mutable-shaped because the transport's own `PayloadLayer` is,
 *  and the two are handed straight across. */
export interface BuiltLayer {
  role: LayerRole;
  selector?: ArtifactSelector;
  files: PayloadFile[];
}

export interface ModulePayload {
  /** The `telo.yaml` that ships, byte for byte: canonicalized, pinned, includes
   *  inlined, `layers:` index written. A dependent's import pin is a hash of
   *  exactly this. */
  readonly manifest: string;
  readonly layers: BuiltLayer[];
  readonly partition: Partition;
  /**
   * Absolute paths of every file the controller builds read — the module's own
   * sources, the shared libraries they inline, their dependency tree. The
   * release edge graph is built from these; nothing else can see what a bundle
   * actually contains.
   */
  readonly buildInputs: readonly string[];
  /**
   * In-repo siblings this module imports relatively: the sibling's absolute
   * manifest path (the release edge) and the ref the import canonicalized to
   * (which publish checks resolves at its published location before pushing).
   */
  readonly relativeImports: readonly {
    readonly manifestPath: string;
    readonly ref: string;
  }[];
  /**
   * Remote imports carrying an author-written pin, already split into the ref
   * and the hash it claims.
   *
   * Split HERE because this is the only place both spellings are in hand: a
   * scalar-form pin carries its hash as a `#sha256-…` fragment on the source,
   * and the object form carries it as an `integrity:` sibling. A consumer handed
   * only the ref can recover the first by re-splitting and the second not at all
   * — which is exactly how the verification below came to be a silent no-op for
   * every pin in this repo.
   *
   * Publish verifies these against the registry — fetch, compare, hard-fail on
   * mismatch. A sibling-derived pin is deliberately not here: it was computed
   * from local bytes the registry has not seen yet, and the batch pushes
   * dependencies first precisely so it does not have to have.
   */
  readonly authoredPins: readonly {
    readonly alias: string;
    /** The ref with no integrity fragment — what the registry is asked for. */
    readonly ref: string;
    /** The hash the author committed. */
    readonly integrity: string;
  }[];
}

export interface PayloadBuilderOptions {
  /** The read-only registry origin `registry://` refs resolve against. Not the
   *  publish destination, which is per module and passed to `payload()`. */
  readonly registryOrigin?: string;
  /** Where the controller build cache lives. */
  readonly cacheRoot: string;
}

/**
 * One module's payload, memoized across a batch.
 *
 * Memoized because a release digests every module in a workspace and the
 * standard library's import graph is dense — `modules/sql`'s published manifest
 * is needed by five dependents to derive their pins, and re-deriving it per
 * dependent would rebuild its controller each time. One memo, not two: a
 * module's published manifest carries its `layers:` index, so producing the
 * text and producing the payload are the same computation.
 */
export class ModulePayloadBuilder {
  private readonly payloads = new Map<string, Promise<ModulePayload>>();
  /** Manifest paths whose payload is in flight, so an import cycle is reported
   *  rather than deadlocking on a memo entry that is awaiting itself. */
  private readonly deriving = new Set<string>();

  /**
   * Where each manifest publishes.
   *
   * A ROOT's destination is an input — which repo a module publishes to is a
   * policy no graph can answer, so the caller states it (the release derives it
   * as `<base>/<directory name>`, the rule the OCI mirror has always used).
   *
   * A SIBLING's is *derived*: the parent's destination with the relative path
   * applied, which is the transport's own rule and exactly what canonicalization
   * writes into the manifest. That one is not a free choice — deriving it
   * independently, from the directory name say, would work for this repo's
   * layout and quietly disagree with the ref the artifact actually carries the
   * moment a layout differs.
   *
   * When a module is reached both ways and the two answers differ,
   * `claimDestination` refuses rather than picking one, because the manifest can
   * only carry a single ref.
   */
  private readonly destinations = new Map<string, string>();

  constructor(private readonly options: PayloadBuilderOptions) {}

  async payload(manifestPath: string, destination: string): Promise<ModulePayload> {
    const key = path.resolve(manifestPath);
    this.claimDestination(key, destination);
    // The cycle check precedes the memo lookup, and has to: a memo entry for a
    // manifest still being derived is exactly the cyclic case, and awaiting it
    // would hang rather than report.
    this.assertNotDeriving(key);
    const existing = this.payloads.get(key);
    if (existing) return existing;
    this.deriving.add(key);
    const work = this.buildPayload(key).finally(() => this.deriving.delete(key));
    this.payloads.set(key, work);
    return work;
  }

  /**
   * The in-repo siblings this module imports relatively, without building a
   * single controller.
   *
   * Publish ORDER needs only this — a dependency must be pushed before its
   * dependents, because canonicalization writes the sibling's ref into the
   * manifest and publish then hard-fails when it does not resolve — and running
   * esbuild across the whole standard library to answer it would be minutes of
   * work for a question the manifests already contain.
   */
  async relativeImportsOf(
    manifestPath: string,
    destination: string,
  ): Promise<readonly { manifestPath: string; ref: string }[]> {
    const key = path.resolve(manifestPath);
    this.claimDestination(key, destination);
    return (await this.transformManifest(key)).relativeImports;
  }

  /**
   * The published `telo.yaml` text — byte for byte what the transport pushes,
   * which is what a dependent hashes to derive its pin.
   *
   * It builds the module's layers, because the `layers:` index is inside that
   * text and each entry's `blob` covers framed bytes. Deriving the manifest
   * alone was cheaper and wrong: the number it produced was of a document that
   * is never published.
   */
  async publishedManifest(manifestPath: string): Promise<string> {
    const key = path.resolve(manifestPath);
    return (await this.payload(key, this.destinationOf(key))).manifest;
  }

  private assertNotDeriving(manifestPath: string): void {
    if (!this.deriving.has(manifestPath)) return;
    throw new Error(
      `Import cycle through '${manifestPath}': a module's published manifest embeds a hash of ` +
        `its dependency's, so a cycle has no fixed point.`,
    );
  }

  private claimDestination(manifestPath: string, destination: string): void {
    const existing = this.destinations.get(manifestPath);
    if (existing && existing !== destination) {
      throw new Error(
        `'${manifestPath}' is being published to both '${existing}' and '${destination}'. ` +
          `A module's destination is part of its published bytes — canonicalization writes it ` +
          `into every relative import — so it cannot be two things in one batch.`,
      );
    }
    this.destinations.set(manifestPath, destination);
  }

  private destinationOf(manifestPath: string): string {
    const destination = this.destinations.get(manifestPath);
    if (!destination) {
      throw new Error(`no publish destination is known for '${manifestPath}'.`);
    }
    return destination;
  }

  /** The transport that owns where this manifest publishes. It decides both the
   *  ref a sibling import canonicalizes to and the framing a layer's `blob`
   *  digest covers, so both halves of the published manifest come from one. */
  private transportFor(manifestPath: string) {
    const destination = this.destinationOf(manifestPath);
    const transport = defaultTransportRegistry(this.options.registryOrigin).forRef(destination);
    if (!transport) {
      throw new Error(`no transport owns publish destination '${destination}'`);
    }
    return transport;
  }

  /**
   * Canonicalize, pin and inline — every rewrite that stands between the
   * author's `telo.yaml` and the published one.
   */
  private async transformManifest(manifestPath: string): Promise<{
    text: string;
    relativeImports: { manifestPath: string; ref: string }[];
    authoredPins: { alias: string; ref: string; integrity: string }[];
  }> {
    const manifestDir = path.dirname(manifestPath);
    const original = fs.readFileSync(manifestPath, "utf8");
    const docs = parseAllDocuments(original, { customTags: defaultCustomTags() });
    const moduleDoc = findModuleDoc(docs);
    const relativeImports: { manifestPath: string; ref: string }[] = [];
    const authoredPins: { alias: string; ref: string; integrity: string }[] = [];

    if (moduleDoc) {
      const destination = this.destinationOf(manifestPath);
      const transport = this.transportFor(manifestPath);

      for (const entry of importSourceRefs(moduleDoc)) {
        const source = entry.source;
        if (!source.startsWith(".") && !source.startsWith("/")) {
          // A remote import. Its pin is authored state — the deliberate
          // statement "I am not affected until I choose to be" — so publishing
          // reads it and never invents one. Refusing an unpinned ref is what
          // keeps the bytes a function of the commit; it used to be resolved
          // over the network, or silently shipped unpinned when that failed.
          const { base, integrity } = splitIntegrity(source);
          const declared = integrity ?? entry.integrity;
          if (declared) {
            authoredPins.push({ alias: entry.alias, ref: base, integrity: declared });
            continue;
          }
          throw new Error(
            `import '${entry.alias}' points at '${source}' with no integrity pin. ` +
              `A pin is written when the dependency is added or moved — run ` +
              `\`telo install\` or \`telo upgrade\` in ${path.basename(manifestDir)} — so that ` +
              `what this artifact embeds is decided by its author rather than by whatever the ` +
              `registry happened to serve at publish time.`,
          );
        }

        const siblingManifest = resolveSiblingManifest(manifestDir, source);
        const version = readSiblingVersion(siblingManifest, source);
        const ref = transport.canonicalizeSiblingRef(destination, source, version);
        relativeImports.push({ manifestPath: siblingManifest, ref });
        this.claimDestination(
          siblingManifest,
          transport.source.resolveRelative(destination, source),
        );
        // The sibling's pin comes from the sibling's own published bytes, in
        // topological order — never from the registry, which has not seen the
        // post-bump version this batch is planning.
        const hash = await this.siblingHash(siblingManifest);
        moduleDoc.setIn(entry.path, `${ref}#${hash}`);
      }
    }

    // Unconditional. Whether a manifest was rewritten is a property of its own
    // content, and letting it decide the serializer meant one commit produced two
    // different byte sequences for the same document.
    const canonical = docs.map((doc) => doc.toString()).join("---\n");
    return {
      text: expandAndInlineIncludes(canonical, manifestDir),
      relativeImports,
      authoredPins,
    };
  }

  private async siblingHash(siblingManifest: string): Promise<string> {
    const published = await this.publishedManifest(siblingManifest);
    return `sha256-${await sha256Base64Url(new TextEncoder().encode(published))}`;
  }

  private async buildPayload(manifestPath: string): Promise<ModulePayload> {
    const manifestDir = path.dirname(manifestPath);
    const { text: manifest, relativeImports, authoredPins } =
      await this.transformManifest(manifestPath);

    const claims = collectModuleFileClaims(manifest);
    const partition = partitionLayers(
      claims,
      selectFiles(manifestDir, readFilesPatterns(manifest)),
      readAssetPatterns(manifest),
    );

    // Every code entry point is BUILT, not read: `path=` names a gitignored
    // artifact that may not exist at all on a fresh clone, and reading a stale
    // one would digest and ship bytes other than the source the manifest says
    // they came from. A library entry point is built exactly like a controller
    // one — it is the same bundle, differing only in who imports it.
    //
    // This runs BEFORE the payload guard, because the guard's job is to reject a
    // file that will not be there when the artifact is read — and an entry point
    // this loop just produced WILL be there. Checking first was a latent break:
    // on a checkout with no `.mjs` files, publish refused before the builder ran
    // and told the author to run a build step this design removed.
    const externals = siblingLibrariesOf(relativeImports);
    const built = new Map<string, Uint8Array>();
    const buildInputs = new Set<string>();
    for (const claim of claims) {
      if (claim.role !== "controller" && claim.role !== "library") continue;
      if (!claim.localPath) continue;
      // One build per entry point, even when several candidates name it: a
      // module's kinds are selected out of one bundle by PURL fragment, and
      // building it once per fragment would be the same bytes N times.
      if (built.has(claim.path)) continue;
      const entry = path.resolve(manifestDir, claim.localPath);
      if (!fs.existsSync(entry)) {
        throw new Error(
          `${claim.role} source '${claim.localPath}' does not exist (from ${claim.origin}).`,
        );
      }
      const bundle = await buildControllerBundle(
        entry,
        this.options.cacheRoot,
        externals.filter((library) => library.format === claim.selector.format),
      );
      built.set(claim.path, fs.readFileSync(bundle.path));
      for (const input of bundle.inputs) buildInputs.add(input);
    }

    assertWithinModule(
      manifestDir,
      partition.layers.flatMap((layer) => layer.files),
      new Set(built.keys()),
    );

    const layers: BuiltLayer[] = partition.layers.map((layer) => ({
      role: layer.role,
      ...(layer.selector ? { selector: layer.selector } : {}),
      files: layer.files.map((rel) => ({
        name: rel,
        content: built.get(rel) ?? fs.readFileSync(path.resolve(manifestDir, rel)),
      })),
    }));

    // The `layers:` index is part of the published manifest, so it is written
    // HERE and not by the transport at push time.
    //
    // A dependent's pin is a hash of this module's published `telo.yaml`, and
    // that hash is taken from what this builder returns. While the index was
    // injected during the push, the builder's manifest was never the published
    // one — so every sibling pin in the standard library named bytes that do
    // not exist at any registry, and each of those dependents failed to resolve
    // its dependency at load. Nothing caught it: the payload-drift gate compares
    // layer digests, which injection does not move, and the ledger's manifest
    // digest was taken pre-injection on both sides.
    //
    // The transport still owns the framing a `blob` digest covers, so the index
    // comes from it; publish re-frames the same layers and hard-fails if a
    // digest moved.
    const index = await this.transportFor(manifestPath).layerIndex(layers);

    return {
      manifest: index.length > 0 ? injectLayerIndex(manifest, index) : manifest,
      layers,
      partition,
      buildInputs: [...buildInputs],
      relativeImports,
      authoredPins,
    };
  }
}

/**
 * The module-owned libraries this module's bundles must not inline, read off the
 * in-repo siblings it imports.
 *
 * Scoped to **relative** imports deliberately, which is the plan's own boundary:
 * a workspace sibling is on disk, so its declared specifier is part of this
 * commit and the bytes stay a pure function of it. A remote dependency's
 * manifest is not, and fetching one to decide whether a specifier is external
 * would make the published bundle depend on network state — the exact leak the
 * pin rules closed. A remote library is therefore inlined at publish, as it
 * always has been.
 */
function siblingLibrariesOf(
  relativeImports: readonly { manifestPath: string }[],
): Array<SiblingLibrary & { format: string }> {
  const out: Array<SiblingLibrary & { format: string }> = [];
  for (const entry of relativeImports) {
    if (!fs.existsSync(entry.manifestPath)) continue;
    const owner = readOwnerManifest(fs.readFileSync(entry.manifestPath, "utf8"));
    const siblingDir = path.dirname(entry.manifestPath);
    for (const candidate of owner.library) {
      out.push({
        specifier: candidate.specifier,
        ...(candidate.localPath
          ? { sourceDir: path.dirname(path.resolve(siblingDir, candidate.localPath)) }
          : {}),
        format: candidate.selector.format,
      });
    }
  }
  return out;
}

/** A relative `imports:` source resolved to the sibling's `telo.yaml`. */
function resolveSiblingManifest(manifestDir: string, source: string): string {
  const resolved = path.resolve(manifestDir, source);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, DEFAULT_MANIFEST_FILENAME);
    }
  } catch {
    throw new Error(`import source '${source}' does not resolve to a file or directory on disk.`);
  }
  return resolved;
}

function readSiblingVersion(siblingManifest: string, source: string): string {
  const first = parseAllDocuments(fs.readFileSync(siblingManifest, "utf8"), {
    customTags: defaultCustomTags(),
  })[0]?.toJSON() as { metadata?: { version?: unknown } } | undefined;
  const version = first?.metadata?.version;
  if (typeof version !== "string") {
    throw new Error(
      `import source '${source}' (resolved: '${siblingManifest}') has no metadata.version, ` +
        `which is what a canonicalized ref names it by.`,
    );
  }
  return version;
}

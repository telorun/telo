import { PackageURL } from "packageurl-js";

/** A kernel that can host a controller candidate.
 *
 *  Telo is polyglot: one manifest is loaded by different kernels, and a given
 *  `controllers:` candidate is hostable by only some of them.
 *
 *  The labels are deliberately the ones the ecosystem already uses — the
 *  `runtime:` field on an `imports:` entry (`LABEL_TO_PURL_TYPE` in
 *  `kernel/nodejs/src/runtime-registry.ts`) and the implementation directory a
 *  contributor sees at `modules/<name>/<label>/`. Coining a third spelling for
 *  the same two kernels would mean an author who wrote `runtime: nodejs` had to
 *  learn that this filter wants something else. */
export type Runtime = "nodejs" | "rust";

const KNOWN_RUNTIMES: readonly Runtime[] = ["nodejs", "rust"];

/** The language a controller is written in, where the PURL actually determines
 *  it. A bundled `napi` / `wasm` artifact does not: a `.node` file may be Rust,
 *  C++ or Zig, so those contribute no language rather than a guess. */
export type Language = "javascript" | "rust";

/** How one `controllers:` candidate maps onto kernels, or `null` when no kernel
 *  hosts it today (an unparseable PURL, a non-`local` `pkg:telo` namespace, or a
 *  bundle format both kernels report as env-missing).
 *
 *  This mirrors what the loaders actually dispatch on. Sources of truth, both of
 *  which must move together with this function:
 *    - Node: `dispatchResolveOne` in `kernel/nodejs/src/controller-loader.ts`
 *      (PURL type → loader) and the `format !== "js"` gate in
 *      `controller-loaders/bundle-loader.ts` (hostable bundle formats).
 *    - Rust: `dispatch_one` in `kernel/rust/src/controller_loader.rs`
 *      (`pkg:cargo` only; everything else is reported unhostable).
 *  The Rust half cannot be imported from here at all, so at least one constant
 *  is unavoidable; keeping both in one function makes the pair reviewable. */
function classifyCandidate(purl: string): { runtimes: Runtime[]; language: Language | null } | null {
  let parsed: PackageURL;
  try {
    parsed = PackageURL.fromString(purl);
  } catch {
    return null;
  }
  switch (parsed.type) {
    // Both kernels consume the identical candidate: Node's napi-loader builds
    // the crate into a `.node` addon, the Rust kernel's cargo_loader into a
    // cdylib opened over telorun-abi. Distribution mode still needs
    // `?local_path=`, but that is an artifact-delivery gap — the manifest is
    // declaring Rust support either way, which is what this reports.
    case "cargo":
      return { runtimes: ["nodejs", "rust"], language: "rust" };
    case "npm":
      return { runtimes: ["nodejs"], language: "javascript" };
    case "telo":
      // Delivery sub-mode lives in the namespace; only `local` (bundled in the
      // module artifact) exists today. The name is the artifact format, and the
      // Node bundle loader hosts `js` alone — `napi` / `wasm` are env-missing on
      // both kernels, so they name no runtime.
      if (parsed.namespace !== "local" || parsed.name !== "js") return null;
      return { runtimes: ["nodejs"], language: "javascript" };
    default:
      return null;
  }
}

export interface KindRuntimeSupport {
  /** Kernels that can load this kind. Empty when it is `portable`, and also when
   *  it declares controllers no kernel hosts — `portable` separates the two. */
  runtimes: Runtime[];
  languages: Language[];
  /** Declares no controllers at all, so no kernel constraint applies. Recorded
   *  as a flag rather than by enumerating today's kernels, which would make every
   *  stored row wrong the day a third kernel ships. */
  portable: boolean;
}

/** Classify one kind from its declared `controllers:` list. */
export function kindRuntimeSupport(controllers: readonly string[]): KindRuntimeSupport {
  if (controllers.length === 0) return { runtimes: [], languages: [], portable: true };

  const runtimes = new Set<Runtime>();
  const languages = new Set<Language>();
  for (const purl of controllers) {
    const hit = classifyCandidate(purl);
    if (!hit) continue;
    for (const r of hit.runtimes) runtimes.add(r);
    if (hit.language) languages.add(hit.language);
  }
  return {
    runtimes: KNOWN_RUNTIMES.filter((r) => runtimes.has(r)),
    languages: [...languages].sort(),
    portable: false,
  };
}

export interface KindRuntimeEntry extends KindRuntimeSupport {
  /** The kind suffix (`metadata.name`), the identity the hub rows key on. */
  name: string;
}

/** Per-kernel coverage across a module's kinds. A kernel that hosts none of them
 *  is absent rather than `"none"`, so the map lists only what actually runs. */
export type RuntimeCoverage = Partial<Record<Runtime, "full" | "partial">>;

export interface ModuleRuntimeReport {
  kinds: KindRuntimeEntry[];
  languages: Language[];
  runtimes: RuntimeCoverage;
  /** Every kind is portable — the module carries no controller code at all. */
  portable: boolean;
}

/** Roll per-kind support up to the module.
 *
 *  A boolean would lie: `std/console` ships Rust controllers for two of its four
 *  kinds, so it is Node-`full` and Rust-`partial`. Portable kinds count as
 *  supported everywhere, which is what keeps a "runs on rust" filter honest for
 *  a module that mixes portable and JS-only kinds. The rollup is recomputed on
 *  every re-ingest, so it self-heals when the kernel set changes. */
export function moduleRuntimeReport(kinds: KindRuntimeEntry[]): ModuleRuntimeReport {
  const languages = new Set<Language>();
  for (const k of kinds) for (const l of k.languages) languages.add(l);

  const runtimes: RuntimeCoverage = {};
  if (kinds.length > 0) {
    for (const runtime of KNOWN_RUNTIMES) {
      const supported = kinds.filter((k) => k.portable || k.runtimes.includes(runtime)).length;
      if (supported === 0) continue;
      runtimes[runtime] = supported === kinds.length ? "full" : "partial";
    }
  }

  return {
    kinds,
    languages: [...languages].sort(),
    runtimes,
    // A module with no kinds at all declares no controllers either, which is
    // vacuously portable — and reads correctly for a manifest-only library.
    portable: kinds.every((k) => k.portable),
  };
}

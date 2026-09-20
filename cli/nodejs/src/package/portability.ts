import { NODE_HOSTED_FORMATS, toolRequirement } from "@telorun/kernel";
import type { ResourceManifest } from "@telorun/sdk";
import { PackageURL } from "packageurl-js";

/**
 * Which controllers may travel inside a packaged application.
 *
 * Two predicates, both read off tables that already exist rather than restated
 * as a list here:
 *
 *  - **the carrier's kernel hosts the candidate's format** — the derivation that
 *    already answers which kernels can host a kind, from its `controllers:`
 *    PURLs. A carrier built from this CLI carries the Node kernel, so the
 *    formats are the Node-hosted ones; the day `cli/rust` becomes a carrier the
 *    same closure gets the opposite verdict here with no edit.
 *  - **the candidate needs no external program on the target machine** — the
 *    kernel's own tool table (`pkg:npm` needs the package manager, `pkg:cargo`
 *    needs cargo).
 *
 * The second is what a payload genuinely cannot carry: an npm tree and a cargo
 * build are materialized for the machine the install runs on, never for
 * `--platform`, and the standalone CLI that usually does the packaging has no
 * package manager at all — so the app would fail at first boot telling its user
 * to install a tool the binary structurally cannot have.
 */

export interface PortabilityRefusal {
  readonly kind: string;
  readonly module?: string;
  /** Every candidate that was tried, with why each one failed. */
  readonly candidates: readonly { readonly purl: string; readonly reason: string }[];
}

export interface CarrierKernel {
  /** The `pkg:telo/local/<format>` formats this carrier's kernel opens. */
  readonly formats: ReadonlySet<string>;
  /** How to name it in a refusal. */
  readonly label: string;
}

/** The carrier this CLI produces: the Node kernel, inside the standalone
 *  binary. */
export const NODE_CARRIER: CarrierKernel = {
  formats: NODE_HOSTED_FORMATS,
  label: "the Node kernel",
};

/** Why this candidate cannot travel, or `undefined` when it can. */
function refuseCandidate(
  purl: string,
  carrier: CarrierKernel,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const tool = toolRequirement(purl, env);
  if (tool) {
    return (
      `needs ${tool.tool} on the machine that runs the app — ${tool.why}, ` +
      `and a packaged application carries no package manager or toolchain`
    );
  }
  let parsed: PackageURL;
  try {
    parsed = PackageURL.fromString(purl);
  } catch {
    return "is not a package URL this telo can read";
  }
  if (parsed.type !== "telo") {
    return `is a pkg:${parsed.type} candidate, which ${carrier.label} does not open`;
  }
  const format = parsed.name;
  if (!carrier.formats.has(format)) {
    return (
      `is a "${format}" controller, which ${carrier.label} does not open ` +
      `(it opens ${[...carrier.formats].map((f) => `"${f}"`).join(", ")})`
    );
  }
  return undefined;
}

/**
 * Every kind in the closure whose candidates all fail. A kind passes as soon as
 * ONE candidate satisfies both predicates, which is what leaves a kind offering
 * a bundled controller beside a crate-built one packageable.
 *
 * Read per CANDIDATE rather than per module, so an application's own
 * `Telo.Definition` declaring a crate-built controller is refused by the same
 * rule as an imported one.
 */
export function unportableKinds(
  manifests: readonly ResourceManifest[],
  carrier: CarrierKernel = NODE_CARRIER,
  env: NodeJS.ProcessEnv = process.env,
): PortabilityRefusal[] {
  // **Only the kinds something declares a resource of.** The kernel resolves a
  // controller when a kind is instantiated and skips the rest, so judging every
  // definition in the closure refuses a whole packaging because an imported
  // module happens to declare one crate-built kind the application never uses.
  const used = instantiatedKinds(manifests);
  const refusals: PortabilityRefusal[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "Telo.Definition") continue;
    const declared = (manifest.metadata ?? {}) as Record<string, unknown>;
    if (typeof declared.name === "string" && !used.has(declared.name)) continue;
    const candidates = (manifest as { controllers?: unknown }).controllers;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const purls = candidates.filter((c): c is string => typeof c === "string");
    const reasons: { purl: string; reason: string }[] = [];
    let portable = false;
    for (const purl of purls) {
      const reason = refuseCandidate(purl, carrier, env);
      if (!reason) {
        portable = true;
        break;
      }
      reasons.push({ purl, reason });
    }
    if (portable) continue;
    const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
    refusals.push({
      kind: typeof metadata.name === "string" ? metadata.name : "(unnamed)",
      ...(typeof metadata.module === "string" ? { module: metadata.module } : {}),
      candidates: reasons,
    });
  }
  return refusals;
}

/**
 * Every kind SUFFIX named anywhere in the closure, which is what a resource's
 * `kind:` carries after its alias.
 *
 * Deliberately over-inclusive — matched on the suffix alone and collected from
 * every `kind` string at any depth, so inline declarations, `with:` scopes and
 * template bodies all count, and two modules declaring the same suffix make both
 * of them used. Judging a kind that is not instantiated costs a refusal the
 * author can act on; missing one that is would let an unpackageable app through,
 * so the error is taken in the safe direction.
 */
function instantiatedKinds(manifests: readonly ResourceManifest[]): Set<string> {
  const used = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind === "string") used.add(kind.slice(kind.lastIndexOf(".") + 1));
    for (const [key, value] of Object.entries(record)) {
      // A kind's own schema is a description of configuration, not a use of
      // anything; walking it would read author data as declarations.
      if (key === "schema" || key === "status" || key === "inputType" || key === "outputType") {
        continue;
      }
      walk(value);
    }
  };
  for (const manifest of manifests) walk(manifest);
  return used;
}

/** The refusal as a reader sees it: what cannot travel, why, and what still
 *  works. */
export function describeRefusals(refusals: readonly PortabilityRefusal[]): string {
  const lines = [
    `${refusals.length} kind${refusals.length === 1 ? "" : "s"} in this application's imports ` +
      `cannot be carried inside an executable:`,
  ];
  for (const refusal of refusals) {
    lines.push(`  ${refusal.module ? `${refusal.module}.` : ""}${refusal.kind}`);
    for (const candidate of refusal.candidates) {
      lines.push(`    ${candidate.purl}`);
      lines.push(`      ${candidate.reason}`);
    }
  }
  lines.push(
    "A packaged application carries only controllers that are files on the target machine. " +
      "The application still runs under an installed telo, which can reach a package manager and a toolchain.",
  );
  return lines.join("\n");
}

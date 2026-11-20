import { splitVcsQualifier, type CycloneDxComponent } from "@telorun/analyzer";
import type { ComponentInput } from "@telorun/osv";

/** What a record's component is looked up as: its package URL without the
 *  version and without the `vcs_url` qualifier, the version, and the repository
 *  and commit that qualifier carries. The version sits at the end of the purl's
 *  head, before any qualifiers or subpath. A component with no package URL or no
 *  version has nothing to look up. */
export function componentLookupInput(component: CycloneDxComponent): ComponentInput | undefined {
  if (!component.purl || component.version === undefined) return undefined;
  const { purl, vcs } = splitVcsQualifier(component.purl);
  const cut = purl.search(/[?#]/);
  const head = cut < 0 ? purl : purl.slice(0, cut);
  const tail = cut < 0 ? "" : purl.slice(cut);
  const suffixes = [`@${component.version}`, `@${encodeURIComponent(component.version)}`];
  const suffix = suffixes.find((candidate) => head.endsWith(candidate));
  return {
    purl: (suffix === undefined ? head : head.slice(0, -suffix.length)) + tail,
    version: component.version,
    ...(vcs ? { vcs } : {}),
  };
}

/** One lookup's identity: purl, version and, when declared, repository and commit. */
export function lookupKey(input: ComponentInput): string {
  return `${input.purl}@${input.version}${input.vcs ? `\0${input.vcs.url}\0${input.vcs.revision}` : ""}`;
}

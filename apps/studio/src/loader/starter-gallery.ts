import { comparePlainVersions, parsePlainVersion } from "@telorun/language-host";
import {
  fetchStarterCatalog,
  StarterCatalogNotFoundError,
  type StarterCatalog,
} from "./starters";

// The starter gallery follows the telo version: each release tag carries the
// `starters/` of that release, written in published form.

const TAG_ROOT = "https://raw.githubusercontent.com/telorun/telo";

/** What the gallery is shown for: an exact telo version, the newest final in the
 *  engine catalog (a workspace with no module to read a version from), or
 *  nothing known yet. */
export type GalleryVersion = { version: string } | { newest: true } | null;

export interface StarterGallery {
  /** The base URL that served the catalog — the one its starters are fetched
   *  from. */
  baseUrl: string;
  /** The telo release whose gallery this is; absent for a gallery that does not
   *  follow the version (a setting, a development build). */
  version?: string;
  catalog: StarterCatalog;
}

/** Nothing can be shown, and why — the words the gallery displays. */
export class StarterGalleryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarterGalleryUnavailableError";
  }
}

export function galleryBaseUrlFor(version: string): string {
  return `${TAG_ROOT}/v${version}/starters`;
}

/** The telo version the gallery follows, from the language session's answer
 *  (the same one a run and a publication ask). */
export function galleryVersionOf(input: {
  workspaceOpen: boolean;
  hasModule: boolean;
  language:
    | { kind: "failed" }
    | { kind: "running"; teloVersion: string; status: { version?: string } }
    | null;
}): GalleryVersion {
  if (!input.workspaceOpen) return { newest: true };
  const { language } = input;
  if (language === null || language.kind === "failed") return null;
  if (language.teloVersion !== "auto") return { version: language.teloVersion };
  if (!input.hasModule) return { newest: true };
  return language.status.version === undefined ? null : { version: language.status.version };
}

/** The tag versions to try, newest first: the version itself when it is a
 *  final release, then every older final of the engine catalog; a prerelease or
 *  unreleased version starts from the newest final. */
export function galleryCandidates(version: GalleryVersion, catalogVersions: readonly string[]): string[] {
  if (version === null) return [];
  const finals = catalogVersions
    .filter((v) => parsePlainVersion(v) !== undefined)
    .sort((a, b) => comparePlainVersions(b, a));
  if ("newest" in version) return finals;
  if (parsePlainVersion(version.version) === undefined) return finals;
  return [
    version.version,
    ...finals.filter((v) => v !== version.version && comparePlainVersions(v, version.version) < 0),
  ];
}

/** Loads the gallery: `fixedBaseUrl` as is, else the first version of
 *  `galleryCandidates` whose tag holds a catalog. Only an absent catalog (404)
 *  moves on to an older version; any other failure is thrown. */
export async function loadStarterGallery(input: {
  fixedBaseUrl: string | undefined;
  version: GalleryVersion;
  catalogVersions: readonly string[];
}): Promise<StarterGallery> {
  if (input.fixedBaseUrl !== undefined) {
    return { baseUrl: input.fixedBaseUrl, catalog: await fetchStarterCatalog(input.fixedBaseUrl) };
  }
  const candidates = galleryCandidates(input.version, input.catalogVersions);
  if (candidates.length === 0) {
    throw new StarterGalleryUnavailableError(
      input.version === null
        ? "The starter gallery follows the telo version, which is not known yet."
        : "The starter gallery follows the telo version, and no released version is known — the version list could not be read. Check your connection and retry.",
    );
  }
  for (const version of candidates) {
    const baseUrl = galleryBaseUrlFor(version);
    try {
      return { baseUrl, version, catalog: await fetchStarterCatalog(baseUrl) };
    } catch (err) {
      if (!(err instanceof StarterCatalogNotFoundError)) throw err;
    }
  }
  const asked = input.version !== null && "version" in input.version ? input.version.version : undefined;
  throw new StarterGalleryUnavailableError(
    asked === undefined
      ? "No starter gallery is published for any released telo version."
      : `No starter gallery is published for telo ${asked}.`,
  );
}

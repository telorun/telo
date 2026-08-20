/**
 * Publishing a module's OWN npm package, for a module whose controller is
 * delivered that way.
 *
 * Most modules bundle their controller into the module artifact, so nothing is
 * fetched at load and there is no package to push. A module that cannot be
 * bundled — one whose driver resolves a native binary relative to its own
 * package directory — names `pkg:npm/<name>@<version>` instead, and that tarball
 * has to exist for any consumer outside this checkout.
 *
 * Nothing was pushing it. Those packages moved from changesets to the module
 * ledger (their version is their module's, so they are listed in
 * `.changeset/config.json`'s `ignore`), and no publisher took over — which is
 * why a module could ship a manifest naming a version of itself that npm had
 * never seen. `telo publish` is where it belongs: it is what ships the module,
 * and the two must go out together or the manifest names a tarball nobody has.
 *
 * Only a package the module OWNS is ever published: same directory, and the name
 * the module's own PURL asks for. A dependency's package is not this module's to
 * release.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** One `controllers:` candidate, already parsed by the caller's PURL parser.
 *  Taking parsed candidates rather than manifest text is deliberate: a second
 *  PURL grammar here would drift from the one the loader and `publish` use the
 *  moment a qualifier moves, and this decides what gets pushed to a registry. */
export interface ControllerCandidate {
  readonly packageName: string;
  readonly versionSpec: string;
  readonly type: string;
  /** The candidate's `local_path` qualifier, already resolved to an absolute
   *  path by the caller's parser — the package directory as the PURL states it,
   *  rather than as a directory-name convention guesses it. */
  readonly localPath?: string;
}

/** A `pkg:npm/<name>@<version>` controller candidate this module owns. */
export interface OwnedNpmPackage {
  readonly name: string;
  /** The version the manifest pins, which must be the module's own. */
  readonly pinnedVersion: string;
  readonly directory: string;
  readonly packageVersion: string;
}

/**
 * The npm packages this module's manifest names and this module's own directory
 * provides. A PURL naming someone else's package resolves from npm as usual and
 * is not returned.
 */
export function ownedNpmPackages(
  controllers: readonly ControllerCandidate[],
  moduleDir: string,
): OwnedNpmPackage[] {
  const owned: OwnedNpmPackage[] = [];
  const seen = new Set<string>();
  for (const candidate of controllers) {
    if (candidate.type !== "npm") continue;
    // The package directory comes from the candidate's own `local_path`, which
    // is what the PURL already says it is. Assuming `<moduleDir>/nodejs` was a
    // layout heuristic in the generic publish path — true of this repo and of
    // nothing that guarantees it.
    const directory = candidate.localPath ?? path.join(moduleDir, "nodejs");
    const pkg = readPackageJson(path.join(directory, "package.json"));
    if (!pkg?.name || !pkg.version || pkg.private) continue;
    if (candidate.packageName !== pkg.name) continue;
    if (!candidate.versionSpec || seen.has(candidate.versionSpec)) continue;
    seen.add(candidate.versionSpec);
    owned.push({
      name: candidate.packageName,
      pinnedVersion: candidate.versionSpec,
      directory,
      packageVersion: pkg.version,
    });
  }
  return owned;
}

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
}

/**
 * A package manifest, or undefined when there is none.
 *
 * A missing file is the ordinary answer for a module that ships no package.
 * A MALFORMED one is not: it is the file this step reads to decide what gets
 * pushed, so reading it as absent would silently skip the publish the caller
 * asked for.
 */
function readPackageJson(file: string): PackageJson | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as PackageJson;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${(err as Error).message}. ` +
        `It decides which package this module publishes, so it cannot be skipped.`,
      { cause: err },
    );
  }
}

/**
 * Why this package cannot be published as it stands, or undefined.
 *
 * A module has ONE version, and a manifest that pins a different one is how the
 * old arrangement failed silently: the package kept moving with its module while
 * the PURL stayed behind, so consumers loaded a tarball years older than the
 * manifest describing it. Stated here rather than repaired, because which of the
 * three is wrong is the author's to say.
 */
export function describeVersionSkew(
  owned: OwnedNpmPackage,
  moduleVersion: string | undefined,
): string | undefined {
  if (owned.packageVersion !== owned.pinnedVersion) {
    return (
      `${owned.name}: the manifest pins ${owned.pinnedVersion} but the package is ` +
      `${owned.packageVersion}. A module has one version across its manifest and its package.`
    );
  }
  if (moduleVersion && moduleVersion !== owned.packageVersion) {
    return (
      `${owned.name}: the package is ${owned.packageVersion} but the module is ${moduleVersion}. ` +
      `A module has one version across its manifest and its package.`
    );
  }
  return undefined;
}

/**
 * Whether npm already has this exact version.
 *
 * An UNREACHABLE registry classifies nothing — the rule `publishedTeloVersions`
 * already follows. `npm view` exits non-zero both for a version that does not
 * exist and for a network or auth failure, and reading the second as the first
 * sends the command on to `npm publish`, where the real cause surfaces as npm's
 * message instead of this one. So only the E404 signal answers "not published";
 * anything else is rethrown with what was actually being asked.
 */
export async function isPublished(name: string, version: string): Promise<boolean> {
  try {
    const { stdout } = await run("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
    });
    return stdout.trim() === version;
  } catch (err) {
    const output = `${(err as { stderr?: string })?.stderr ?? ""}${
      (err as { stdout?: string })?.stdout ?? ""
    }`;
    if (/E404|code E404|is not in this registry|No match found/i.test(output)) return false;
    throw new Error(
      `could not ask npm whether ${name}@${version} is published: ` +
        `${(err as Error)?.message ?? String(err)}. ` +
        `Publishing was not attempted — an unreachable registry is not an answer.`,
      { cause: err },
    );
  }
}

export async function publishPackage(owned: OwnedNpmPackage): Promise<void> {
  await run("npm", ["publish", "--access", "public"], {
    cwd: owned.directory,
    encoding: "utf8",
  });
}

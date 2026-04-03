export type BumpLevel = "patch" | "minor" | "major";

export interface ParsedController {
  /** Full original PURL string */
  purl: string;
  /** PURL type: "npm", "cargo", etc. */
  type: string;
  /** Scoped package name, e.g. "@telorun/run" */
  packageName: string;
  /** Version spec from the PURL, e.g. ">=1.0.0" or "0.1.1" */
  versionSpec: string;
  /** Resolved absolute path to the package directory */
  localPath: string;
  /** Entry point fragment, e.g. "sequence" */
  entry: string;
}

export interface ControllerPublisher {
  /** PURL type this publisher handles, e.g. "npm" */
  type: string;

  /** Return the current version from the package manifest (e.g. package.json) */
  readVersion(localPath: string): Promise<string>;

  /** Bump the version in the package manifest and return the new version string */
  bumpVersion(localPath: string, level: BumpLevel): Promise<string>;

  /** Build the package */
  build(localPath: string): Promise<void>;

  /**
   * Publish the package to its registry.
   * If the version already exists, resolve without throwing — return false to
   * indicate it was skipped (caller should warn), true if published.
   */
  publish(localPath: string, version: string): Promise<boolean>;
}

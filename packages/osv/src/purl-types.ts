/**
 * The package types OSV matches by purl and version, as data: purl type to the OSV
 * ecosystem its advisories are filed under. A type absent here is never judged clean.
 */
export const OSV_ECOSYSTEMS: Readonly<Record<string, string>> = {
  npm: "npm",
  cargo: "crates.io",
  pypi: "PyPI",
  golang: "Go",
  maven: "Maven",
  nuget: "NuGet",
  gem: "RubyGems",
  composer: "Packagist",
  hex: "Hex",
  pub: "Pub",
};

/** The type of a purl (`npm` of `pkg:npm/lodash`), lower-cased; undefined when it is no purl. */
export function purlType(purl: string): string | undefined {
  const match = /^pkg:([A-Za-z][A-Za-z0-9.+-]*)\//.exec(purl);
  return match ? match[1].toLowerCase() : undefined;
}

/** Whether OSV matches this purl's package type by version. */
export function isChecked(purl: string): boolean {
  const type = purlType(purl);
  return type !== undefined && Object.hasOwn(OSV_ECOSYSTEMS, type);
}

/** The OSV package name a versionless purl names, in the ecosystem's own spelling. */
export function osvPackageName(purl: string): string | undefined {
  const type = purlType(purl);
  if (type === undefined) return undefined;
  const path = purl.slice(`pkg:${type}/`.length).split(/[?#]/, 1)[0];
  const segments = path.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const name = segments.pop() ?? "";
  if (segments.length === 0) return name;
  return type === "maven" ? `${segments.join(".")}:${name}` : `${segments.join("/")}/${name}`;
}

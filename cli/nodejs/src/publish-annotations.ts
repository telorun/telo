/** A reverse-domain annotation key: two or more dot-separated segments of
 *  letters, digits, `-` and `_`, each starting and ending alphanumeric. */
const ANNOTATION_KEY =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)+$/;

/**
 * Read `telo publish --annotation <key>=<value>` occurrences into one map.
 *
 * Each is split at its first `=`, so a value may itself contain `=`. A key
 * given twice is refused rather than resolved by position: which of two
 * values an author meant is not something a flag order can answer. Whether a
 * transport can write a key is the transport's question, asked separately.
 */
export function parseAnnotationFlags(flags: readonly string[]): Record<string, string> {
  const annotations: Record<string, string> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq < 0) {
      throw new Error(`--annotation '${flag}' has no '=' — write it as <key>=<value>.`);
    }
    const key = flag.slice(0, eq);
    if (!ANNOTATION_KEY.test(key)) {
      throw new Error(
        `--annotation key '${key}' is not a reverse-domain name — write two or more ` +
          `dot-separated segments of letters, digits, '-' and '_', each starting and ending ` +
          `with a letter or digit (e.g. com.example.note).`,
      );
    }
    if (Object.hasOwn(annotations, key)) {
      throw new Error(`--annotation '${key}' is given twice — pass each key once.`);
    }
    annotations[key] = flag.slice(eq + 1);
  }
  return annotations;
}

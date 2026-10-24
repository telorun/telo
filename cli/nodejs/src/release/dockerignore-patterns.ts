/**
 * A Docker ignore file read as Telo glob exclude patterns.
 *
 * Docker anchors every pattern at the build-context root, and a pattern naming a
 * directory excludes everything beneath it. The Telo glob floats a slash-free
 * pattern to any depth and matches a bare name only as a file, so each line is
 * rewritten into its anchored form plus that form's subtree. Last-match-wins is
 * shared by both, so a `!` re-include keeps its meaning.
 */
export function dockerignorePatterns(text: string, file: string): string[] {
  const patterns: string[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (/[[\]\\]/.test(line)) {
      throw new Error(
        `${file}:${index + 1}: '${line}' uses a character class or an escape, which the image digest cannot read the way Docker does — rewrite it with '*', '?' and '**' only`,
      );
    }
    const negated = line.startsWith("!");
    const body = (negated ? line.slice(1) : line).replace(/^\/+/, "").replace(/\/+$/, "");
    const prefix = negated ? "!/" : "/";
    patterns.push(prefix + body, prefix + body + "/");
  });
  return patterns;
}

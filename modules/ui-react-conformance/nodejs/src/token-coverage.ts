import type { Problem } from "./problem.js";
import type { ReadStylesheet } from "./style-coverage.js";

/**
 * The token checks: every design token has a default — from the theme's own
 * token set, or a `:root` rule of its stylesheets — and is read by some `var()`
 * of them, unless the renderer's own layer reads it. `tokens` are the token
 * names as a token set spells them, and `propertyOf` spells one as the custom
 * property the renderer sets.
 */
export function tokenProblems(
  tokens: readonly string[],
  propertyOf: (token: string) => string,
  rendererTokens: readonly string[],
  themeTokens: readonly string[],
  sheets: readonly ReadStylesheet[],
): Problem[] {
  const given = new Set(themeTokens);
  const declared = new Set(sheets.flatMap(({ reading }) => [...reading.rootDeclarations]));
  const read = new Set(sheets.flatMap(({ reading }) => [...reading.reads]));
  const problems: Problem[] = [];
  for (const token of tokens) {
    if (given.has(token) || declared.has(propertyOf(token))) continue;
    problems.push({
      check: "token-default-missing",
      subject: token,
      message: `The token '${token}' has no value of the theme's own: give it one in the theme's 'tokens', or declare '${propertyOf(token)}' in a ':root' rule of its stylesheets.`,
    });
  }
  for (const token of tokens) {
    if (read.has(propertyOf(token)) || rendererTokens.includes(token)) continue;
    problems.push({
      check: "token-unread",
      subject: token,
      message: `No 'var(${propertyOf(token)})' in the theme's stylesheets reads the token '${token}', so a brand setting it changes nothing.`,
    });
  }
  return problems;
}

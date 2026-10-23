import { describe, expect, it } from "vitest";
import { readStylesheet } from "../src/stylesheet-rules.js";
import { tokenProblems } from "../src/token-coverage.js";

const tokens = ["color.accent", "radius.md"];
const propertyOf = (token: string) => `--telo-${token.replaceAll(".", "-")}`;

function problemsOf(css: string, themeTokens: string[] = [], rendererTokens: string[] = []) {
  const read = readStylesheet(css);
  if (!read.ok) throw new Error(read.message);
  return tokenProblems(tokens, propertyOf, rendererTokens, themeTokens, [{ path: "/theme.css", reading: read.reading }]);
}

describe("the token checks", () => {
  it("report a token neither the theme's token set nor an unconditional :root rule gives a value", () => {
    expect(
      problemsOf(`:root { --telo-radius-md: 4px } @media (prefers-color-scheme: dark) { :root { --telo-color-accent: red } } a { color: var(--telo-color-accent); border-radius: var(--telo-radius-md) }`),
    ).toEqual([
      {
        check: "token-default-missing",
        subject: "color.accent",
        message: "The token 'color.accent' has no value of the theme's own: give it one in the theme's 'tokens', or declare '--telo-color-accent' in a ':root' rule of its stylesheets.",
      },
    ]);
    expect(problemsOf(`@layer look { :root { --telo-radius-md: 4px } } a { color: var(--telo-color-accent); border-radius: var(--telo-radius-md) }`, ["color.accent"])).toEqual([]);
  });

  it("report a token no var() reads, a fallback's counting", () => {
    expect(problemsOf(`:root { --telo-color-accent: red; --telo-radius-md: 4px } a { color: var(--x, var(--telo-color-accent)) }`)).toEqual([
      {
        check: "token-unread",
        subject: "radius.md",
        message: "No 'var(--telo-radius-md)' in the theme's stylesheets reads the token 'radius.md', so a brand setting it changes nothing.",
      },
    ]);
    expect(problemsOf(`:root { --telo-color-accent: red; --telo-radius-md: 4px } a { color: var(--telo-color-accent) }`, [], ["radius.md"])).toEqual([]);
  });
});

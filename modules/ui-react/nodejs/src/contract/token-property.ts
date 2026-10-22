/** The custom property a design token is set as on the page: `color.accent-text` → `--telo-color-accent-text`. */
export function tokenProperty(token: string): string {
  return `--telo-${token.replaceAll(".", "-")}`;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export interface Shell {
  title: string;
  lang?: string;
  /** Mount prefix, with no trailing slash; empty at the root. */
  prefix: string;
  /** The renderer's digest. */
  bundle: string;
  rendererUrl: string;
  importMap: Record<string, string>;
}

/**
 * The one HTML document every page address answers with. It holds no content:
 * the layer order, the import map that gives the page one React, and the
 * renderer, which fetches everything else.
 */
export function shellHtml(shell: Shell): string {
  // `<` cannot end the script element early once it is written as an escape.
  const importMap = JSON.stringify({ imports: shell.importMap }).replace(/</g, "\\u003c");
  const lang = shell.lang === undefined ? "" : ` lang="${escapeHtml(shell.lang)}"`;
  return [
    "<!doctype html>",
    `<html${lang}>`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(shell.title)}</title>`,
    "<style>@layer telo.base, telo.theme, telo.component;</style>",
    `<script type="importmap">${importMap}</script>`,
    "</head>",
    "<body>",
    `<div id="telo-root" data-telo-mount="${escapeHtml(shell.prefix)}" data-telo-bundle="${escapeHtml(shell.bundle)}"></div>`,
    `<script type="module" src="${escapeHtml(shell.rendererUrl)}"></script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

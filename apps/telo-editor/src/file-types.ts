import { pathBasename, pathExtname } from "./loader/paths";

/** Extensions Monaco can't usefully render as text. Opening one shows a
 *  placeholder tab instead of feeding the binary into the editor. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".avi", ".webm", ".mkv",
  ".wasm", ".so", ".dylib", ".dll", ".exe", ".bin",
]);

/** Maps a file extension to a Monaco language id. Unknown extensions fall back
 *  to `plaintext`. Filenames without an extension are matched by basename. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".jsonc": "json",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".toml": "ini",
  ".ini": "ini",
  ".env": "ini",
  ".sql": "sql",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".xml": "xml",
  ".svg": "xml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dockerfile": "dockerfile",
};

const LANGUAGE_BY_BASENAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  makefile: "makefile",
};

export function isBinaryFile(path: string): boolean {
  return BINARY_EXTENSIONS.has(pathExtname(path).toLowerCase());
}

export function languageForFile(path: string): string {
  const ext = pathExtname(path).toLowerCase();
  if (ext && LANGUAGE_BY_EXTENSION[ext]) return LANGUAGE_BY_EXTENSION[ext];
  const base = pathBasename(path).toLowerCase();
  return LANGUAGE_BY_BASENAME[base] ?? "plaintext";
}

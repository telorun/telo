import type { FileEvent, FileSystemWatcher } from "vscode-languageserver-protocol";
import { canonicalUri } from "./canonical-uri.js";

/** LSP's glob syntax as a regular expression over `/`-separated paths:
 *  `*` and `?` within a segment, `**` across segments, `{a,b}` alternatives,
 *  `[…]` / `[!…]` character ranges. */
function globRegExp(glob: string): RegExp {
  let source = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      source += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      depth++;
      source += "(?:";
    } else if (char === "}" && depth > 0) {
      depth--;
      source += ")";
    } else if (char === "," && depth > 0) source += "|";
    else if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) source += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else source += char.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function decodedPath(uri: string): string {
  return decodeURIComponent(new URL(canonicalUri(uri)).pathname);
}

const WATCH_KIND = { 1: 1, 2: 2, 3: 4 } as const;

/** Whether a file event is one `watcher` asks for: the path matches its glob
 *  (a relative pattern against its base) and the change is of a watched kind. */
export function watcherMatches(watcher: FileSystemWatcher, event: FileEvent): boolean {
  const kind = watcher.kind ?? 7;
  if ((kind & WATCH_KIND[event.type as 1 | 2 | 3]) === 0) return false;
  const path = decodedPath(event.uri);
  const pattern = watcher.globPattern;
  if (typeof pattern === "string") return globRegExp(pattern).test(path);
  const base = typeof pattern.baseUri === "string" ? pattern.baseUri : pattern.baseUri.uri;
  const root = decodedPath(base).replace(/\/?$/, "/");
  return path.startsWith(root) && globRegExp(pattern.pattern).test(path.slice(root.length));
}

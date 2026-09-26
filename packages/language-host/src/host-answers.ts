import { TELO_MODULE_FILENAME } from "@telorun/editor-protocol";
import type { HubClient } from "./hub-client.js";
import type { HostFileSystem, HostServices, RemoteReader } from "./host-seams.js";

/** `relative` against the directory of the file `base` names — URI arithmetic,
 *  the same for every host. */
function againstDirectoryOf(base: string, relative: string): string {
  return new URL(relative, base).href;
}

function withinDirectory(directory: string, name: string): string {
  return new URL(name, directory.endsWith("/") ? directory : `${directory}/`).href;
}

/**
 * Every `telo/*` answer, built from the host's raw seams. The rules are written
 * here once: a directory reads as its `telo.yaml` and answers with that file's
 * URI; a path naming nothing is `null` (for `read` and `listDirectory`) or
 * `false` (for `exists`); a directory listing of a file is `null`; anything
 * else the host could not do is an error carrying its reason.
 */
export function hostAnswers(files: HostFileSystem, remote: RemoteReader, hub: HubClient): HostServices {
  return {
    "telo/read": async ({ uri }) => {
      if (!uri.startsWith("file:")) return remote(uri);
      const kind = await files.stat(uri);
      if (kind === undefined) return null;
      const file = kind === "directory" ? withinDirectory(uri, TELO_MODULE_FILENAME) : uri;
      if (kind === "directory" && (await files.stat(file)) !== "file") return null;
      return { uri: file, text: await files.readText(file) };
    },
    "telo/exists": async ({ base, relative }) =>
      (await files.stat(againstDirectoryOf(base, relative))) !== undefined,
    "telo/listDirectory": async ({ uri }) =>
      (await files.stat(uri)) === "directory" ? files.readDirectory(uri) : null,
    "telo/hub/searchRefs": ({ query }) => hub.searchRefs(query),
    "telo/hub/listVersions": ({ ref }) => hub.listVersions(ref),
  };
}

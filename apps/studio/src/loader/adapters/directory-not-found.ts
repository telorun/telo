/** Thrown by `WorkspaceAdapter.listDir` when the path names nothing or names a
 *  file, so a caller can tell an absent directory from a failed read. */
export class DirectoryNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`'${path}' is not a directory`);
    this.name = "DirectoryNotFoundError";
  }
}

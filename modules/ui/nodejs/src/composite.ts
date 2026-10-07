/** The contract every `Ui.Composite` provides: the node a renderer draws and
 *  the files a browser must load for it. */

export type SpecNode = { type: string } & Record<string, unknown>;

export interface AssetFile {
  /** Hex SHA-256 the file is addressed by. */
  digest: string;
  /** Path below the digest; a browser entry's chunks keep theirs relative to it. */
  name: string;
  /** Absolute path of the file on this host. */
  file: string;
  mediaType: string;
}

export interface Provided {
  /** Absent when the composite has nothing to show. */
  node?: SpecNode;
  assets: AssetFile[];
}

export interface CompositeInstance {
  provide(): Promise<Provided>;
}

export function isComposite(candidate: unknown): candidate is CompositeInstance {
  return typeof (candidate as CompositeInstance | null)?.provide === "function";
}

/** One list, each file once. */
export function mergeAssets(...lists: AssetFile[][]): AssetFile[] {
  const seen = new Map<string, AssetFile>();
  for (const asset of lists.flat()) seen.set(`${asset.digest}/${asset.name}`, asset);
  return [...seen.values()];
}

export type Style = string | string[];

export function mergeStyles(own: Style | undefined, added: Style | undefined): Style | undefined {
  if (added === undefined) return own;
  if (own === undefined) return added;
  return [...new Set([own, added].flat())];
}

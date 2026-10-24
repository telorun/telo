/**
 * sha256 hex of a UTF-8 string — byte-for-byte identical to the `fs` module's
 * `Fs.TreeSnapshot` (Node `createHash("sha256").update(Buffer.from(text,"utf8"))`),
 * so the editor's hashes and the agent's tree hashes are directly comparable.
 * Uses the browser SubtleCrypto (available in the editor and Tauri webviews).
 */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}

/** sha256 hex of bytes — what the workspace surfaces hash a file by, so a
 *  file that is not UTF-8 compares by what it holds. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

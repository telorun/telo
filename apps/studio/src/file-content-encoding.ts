/** A file's bytes as a JSON string: the text when they are UTF-8, base64
 *  otherwise, so a binary file crosses a text-only wire intact. */
export function encodeFileContent(bytes: Uint8Array): {
  content: string;
  encoding: "utf8" | "base64";
} {
  const text = utf8Text(bytes);
  return text === null
    ? { content: toBase64(bytes), encoding: "base64" }
    : { content: text, encoding: "utf8" };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The file as text, or null when its bytes are not UTF-8. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

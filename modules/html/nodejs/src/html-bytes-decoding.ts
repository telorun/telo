/** Bytes → text, by the HTML encoding sniffing algorithm: a byte order mark,
 *  then the declared charset, then the `<meta>` prescan of the first 1024
 *  bytes, then UTF-8. Decoding never fails: bytes outside the encoding become
 *  U+FFFD. */

import { TextDecoder } from "@exodus/bytes/encoding.js";
import sniffHtmlEncoding from "html-encoding-sniffer";

export function decodeHtmlBytes(bytes: Uint8Array, charset: string | undefined): string {
  const encoding = sniffHtmlEncoding(bytes, {
    transportLayerEncodingLabel: charset,
    defaultEncoding: "UTF-8",
  });
  // The replacement encoding decodes any non-empty input to one U+FFFD; the
  // decoder refuses to be constructed for it.
  if (encoding.toLowerCase() === "replacement") return bytes.length === 0 ? "" : "�";
  return new TextDecoder(encoding).decode(bytes);
}

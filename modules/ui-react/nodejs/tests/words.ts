import { readMessage } from "@telorun/message-format";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

/** A text as the server sends it: the Message parsed, in English. */
export function wireText(text: unknown, lang = "en") {
  const read = readMessage(text);
  if (!read.ok) throw new Error(`not a message: ${JSON.stringify(text)}`);
  return { message: read.message, lang };
}

/** The renderer's own words as `ui` writes them, in English, as a server sends them. */
export const englishWords: Record<string, ReturnType<typeof wireText>> = (() => {
  const docs = parseAllDocuments(readFileSync(join(process.cwd(), "../../ui/telo.yaml"), "utf8"), { logLevel: "silent" }).map((doc) => doc.toJS());
  const words = docs.find((doc) => doc.kind === "Self.Words" && doc.metadata?.name === "words");
  return Object.fromEntries(
    Object.entries(words).filter(([key]) => key !== "kind" && key !== "metadata").map(([id, text]) => [id, wireText(text)]),
  );
})();


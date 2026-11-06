import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

// The router restates the server's access refusals so its catch lists can name
// them; the two declarations are one contract.
describe("the access refusals Http.Api restates", () => {
  it("are declared exactly as Http.Server declares them", () => {
    const documents = parseAllDocuments(readFileSync(join(here, "../../telo.yaml"), "utf8")).map((d) => d.toJSON());
    const codesOf = (name: string) => documents.find((d) => d?.metadata?.name === name)!.throws.codes;
    const server = codesOf("Server");
    const api = codesOf("Api");
    const raised = [
      "ERR_HTTP_UNAUTHENTICATED",
      "ERR_HTTP_FORBIDDEN",
      "ERR_HTTP_CROSS_ORIGIN_REFUSED",
      "ERR_HTTP_ACCESS_CHECK_UNAVAILABLE",
    ];
    expect(Object.keys(api).sort()).toEqual([...raised].sort());
    for (const code of raised) expect(api[code]).toEqual(server[code]);
  });
});

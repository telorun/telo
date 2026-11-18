import { describe, expect, it } from "vitest";

import { parseVisitorHost } from "./visitor-host.js";

const ID = "k3xqz2m7ahc4";

describe("parseVisitorHost", () => {
  const rows: Array<[string | undefined, ReturnType<typeof parseVisitorHost>]> = [
    [`8080-${ID}.telorun.dev`, { shareId: ID, port: 8080 }],
    [`site--8080-${ID}.telorun.dev`, { shareId: ID, port: 8080 }],
    [`my-site--443-${ID}.telorun.dev`, { shareId: ID, port: 443 }],
    [`a--b--1-${ID}.telorun.dev`, { shareId: ID, port: 1 }],
    [`8080-${ID.toUpperCase()}.TELORUN.DEV:443`, { shareId: ID, port: 8080 }],
    [`65535-${ID}.telorun.dev.`, { shareId: ID, port: 65535 }],
    [`65536-${ID}.telorun.dev`, undefined],
    [`0-${ID}.telorun.dev`, undefined],
    [`08080-${ID}.telorun.dev`, undefined],
    [`site-8080-${ID}.telorun.dev`, undefined],
    [`8080-${ID}.other.dev`, undefined],
    [`x.8080-${ID}.telorun.dev`, undefined],
    [`8080-${ID}x.telorun.dev`, undefined],
    [`8080-k3xqz2m7ahc1.telorun.dev`, undefined],
    [`tunnel.telorun.dev`, undefined],
    [`telorun.dev`, undefined],
    [undefined, undefined],
  ];
  for (const [host, expected] of rows) {
    it(`reads ${String(host)}`, () => {
      expect(parseVisitorHost(host, "telorun.dev")).toEqual(expected);
    });
  }
});

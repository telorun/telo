import { describe, expect, it } from "vitest";
import { claimTokenName, ERR_ONE_TIME_NAME_DUPLICATE } from "../src/one-time-name-claims.js";

describe("token set name claims", () => {
  it("refuse a second claim on one store and are freed by the release a reconcile runs", () => {
    const store = {};
    const [links, codes, recreated] = [{}, {}, {}];
    const release = claimTokenName(store, "main", links, 'OneTime.Links "links"');
    expect(() => claimTokenName(store, "main", codes, 'OneTime.Codes "codes"')).toThrow(
      expect.objectContaining({ code: ERR_ONE_TIME_NAME_DUPLICATE, data: { name: "main" } }),
    );
    release();
    expect(() => claimTokenName(store, "main", recreated, 'OneTime.Links "links"')).not.toThrow();
  });
});

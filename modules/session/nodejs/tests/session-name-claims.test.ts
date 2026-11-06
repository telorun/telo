import { describe, expect, it } from "vitest";
import { claimSessionName, ERR_SESSION_NAME_DUPLICATE } from "../src/session-name-claims.js";

describe("session name claims", () => {
  it("are freed by the release a reconcile runs, so a re-created set claims with no stale claim", () => {
    const store = {};
    const [web, admin, recreated] = [{}, {}, {}];
    const release = claimSessionName(store, "main", web, 'Session.Sessions "web"');
    expect(() => claimSessionName(store, "main", admin, 'Session.Sessions "admin"')).toThrow(
      expect.objectContaining({ code: ERR_SESSION_NAME_DUPLICATE, data: { name: "main" } }),
    );
    release();
    expect(() => claimSessionName(store, "main", recreated, 'Session.Sessions "web"')).not.toThrow();
    // A release of a claim since taken over leaves the new holder's claim in place.
    release();
    expect(() => claimSessionName(store, "main", admin, 'Session.Sessions "admin"')).toThrow();
  });
});

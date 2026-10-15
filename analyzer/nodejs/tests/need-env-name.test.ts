import { describe, expect, it } from "vitest";
import { derivedNeedEnvName } from "../src/need-env-name.js";

describe("derivedNeedEnvName", () => {
  it.each([
    [["Orders", "databaseAccess"], "url", "TELO_NEED_ORDERS__DATABASE_ACCESS__URL"],
    [["HTTPServer", "dbAccess"], "url", "TELO_NEED_HTTP_SERVER__DB_ACCESS__URL"],
    [["sessionKey"], "value", "TELO_NEED_SESSION_KEY__VALUE"],
    [["SQL", "v2Api"], "maxPool", "TELO_NEED_SQL__V2_API__MAX_POOL"],
  ])("%j field %s → %s", (path, field, expected) => {
    expect(derivedNeedEnvName(path, field)).toBe(expected);
  });
});

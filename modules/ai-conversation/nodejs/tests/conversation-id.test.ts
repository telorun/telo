import { describe, expect, it } from "vitest";
import { mintAttachmentId, mintConversationId, mintEntryId } from "../src/conversation-id.js";

describe("conversation ids", () => {
  it("carry a prefix and 22 base-62 characters, never repeating", () => {
    const ids = Array.from({ length: 500 }, mintEntryId);
    expect(new Set(ids).size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^ent_[0-9A-Za-z]{22}$/);
    expect(mintConversationId()).toMatch(/^cnv_[0-9A-Za-z]{22}$/);
    expect(mintAttachmentId()).toMatch(/^att_[0-9A-Za-z]{22}$/);
  });
});

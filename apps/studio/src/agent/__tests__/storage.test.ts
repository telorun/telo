import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_KEYS, LOCAL_PREFIXES } from "../../storage-keys";
import { loadConversationId, purgeStoredTranscripts } from "../storage";

afterEach(() => {
  localStorage.clear();
});

describe("agent browser storage", () => {
  it("deletes stored transcripts and keeps settings and the workspace's conversation", () => {
    localStorage.setItem(LOCAL_PREFIXES.agentChat + "c1", JSON.stringify({ messages: [] }));
    localStorage.setItem(LOCAL_PREFIXES.agentChat + "c2", JSON.stringify({ messages: [] }));
    localStorage.setItem(LOCAL_KEYS.agentSettings, JSON.stringify({ panelOpen: true }));
    localStorage.setItem(LOCAL_PREFIXES.agentConv + "/ws", JSON.stringify({ id: "c1" }));

    purgeStoredTranscripts();

    expect(Object.keys(localStorage).sort()).toEqual(
      [LOCAL_KEYS.agentSettings, LOCAL_PREFIXES.agentConv + "/ws"].sort(),
    );
    expect(loadConversationId("/ws")).toBe("c1");
  });
});

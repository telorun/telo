import { describe, expect, it } from "vitest";

import { isFocusComposerShortcut } from "../composer-shortcuts";

describe("the focus-composer shortcut", () => {
  it("is Cmd/Ctrl+J, and leaves Cmd/Ctrl+K — the prefix of the source view's chords — alone", () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(isFocusComposerShortcut(key({ key: "j", ctrlKey: true }))).toBe(true);
    expect(isFocusComposerShortcut(key({ key: "J", metaKey: true }))).toBe(true);
    expect(isFocusComposerShortcut(key({ key: "k", ctrlKey: true }))).toBe(false);
    expect(isFocusComposerShortcut(key({ key: "j" }))).toBe(false);
    expect(isFocusComposerShortcut(key({ key: "j", ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("lists in the docs the expansion the eject test proves", () => {
  const listing = read("../../docs/ui.md").match(/it is exactly:\n\n```yaml\n([\s\S]*?)```/)?.[1];
  expect(listing).toBeDefined();
  expect(read("../../tests/ui-eject.yaml")).toContain(listing);
});

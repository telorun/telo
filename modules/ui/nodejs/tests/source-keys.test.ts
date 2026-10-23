import { describe, expect, it } from "vitest";
import { sourceKeys } from "../src/source-keys.js";

const record = (text: unknown) => ({ text, context: null, lang: "en", computed: false });

describe("the keys of siblings", () => {
  it("are the slugs of their source texts, a later sibling of a taken key numbered, under a prefix", () => {
    const texts = [
      record("Zażółć Reports!"),
      record({ plural: "count", cases: { one: "{$count} task", other: "{$count} tasks" } }),
      { text: record("Reports"), values: {} },
      record("zazolc reports"),
      record("…"),
      record("Zażółć  reports"),
    ];
    expect(sourceKeys(texts, "entry", "admin/")).toEqual([
      "admin/zazołc-reports",
      "admin/count-tasks",
      "admin/reports",
      "admin/zazolc-reports",
      "admin/entry",
      "admin/zazołc-reports~2",
    ]);
  });
});

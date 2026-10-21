// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, wireText, type Rendered } from "./harness.js";
import { formNode, operation } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** What the server sends for `minLength` in Polish: the translation, parsed. */
const polishMinLength = wireText(
  { plural: "limit", cases: { one: "Co najmniej {$limit} znak", few: "Co najmniej {$limit} znaki", other: "Co najmniej {$limit} znaków" } },
  "pl",
);

/** Every text a page shows arrives translated and parsed: the browser formats
 *  it with the message core — plural choice, placeholders, numbers — and holds
 *  no catalog. */
describe("a page in Polish", () => {
  it.each([
    [3, "Co najmniej 3 znaki"],
    [5, "Co najmniej 5 znaków"],
  ])("fills a validation word's limit of %d with its plural case", async (limit, expected) => {
    const form = formNode();
    const schema = { ...form.schema, properties: { ...form.schema.properties, text: { type: "string", title: "Task", minLength: limit } } };
    rendered = await render({
      path: "/",
      lang: "pl",
      words: { minLength: polishMinLength },
      pages: { "/": { title: "Zadania", children: [{ ...form, schema }] } },
    });
    await rendered.enter(rendered.parts("input")[0], "a");
    expect(rendered.part("field-error").textContent).toBe(expected);
  });

  it.each([
    [1, "1 nieopłacona pozycja"],
    [3, "3 nieopłacone pozycje"],
    [5, "5 nieopłaconych pozycji"],
  ])("draws an author's heading over an answer holding %d in its plural case", async (count, expected) => {
    const heading = {
      ...wireText({ plural: "n", cases: { one: "{$n} nieopłacona pozycja", few: "{$n} nieopłacone pozycje", other: "{$n} nieopłaconych pozycji" } }, "pl"),
      values: { n: { root: "result", path: ["unpaid"] } },
    };
    rendered = await render({
      path: "/",
      lang: "pl",
      answers: { "/api/check": () => json({ unpaid: count }) },
      pages: {
        "/": {
          title: "Faktury",
          children: [
            operation("/api/check", "Sprawdź", { type: "object", properties: {} }, {
              answer: { type: "object", properties: { unpaid: { type: "integer" } } },
              result: { type: "text", text: heading, style: "heading" },
            }),
          ],
        },
      },
    });
    await rendered.click(rendered.part("submit"));
    expect(rendered.part("action-result").textContent).toBe(expected);
  });
});

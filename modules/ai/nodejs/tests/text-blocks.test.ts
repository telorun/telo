import { describe, expect, it } from "vitest";
import { extractBlocks } from "../src/text-blocks.js";
import { canonicalJson, textCallId } from "../src/text-call-id.js";

const listed = new Set(["telo-edit", "telo-file"]);
const fence = (n: number) => "`".repeat(n);

describe("extractBlocks", () => {
  it("reads a listed block's tag, attributes in written order and raw body, final newline included", () => {
    const text = `Here:\n${fence(3)}telo-file path=a/b.yaml mode=new\nkind: X\n  "q": '\\n'\n${fence(3)}\ndone`;
    expect(extractBlocks(text, listed)).toEqual({
      blocks: [
        {
          tag: "telo-file",
          attributes: [
            ["path", "a/b.yaml"],
            ["mode", "new"],
          ],
          body: `kind: X\n  "q": '\\n'\n`,
        },
      ],
    });
  });

  it("returns every listed block in reply order and leaves unlisted fences as text", () => {
    const text = [
      `${fence(3)}telo-edit path=x`,
      "one",
      fence(3),
      `${fence(3)}yaml`,
      "ignored",
      fence(3),
      `${fence(3)}telo-file path=y`,
      "two",
      fence(3),
    ].join("\n");
    const { blocks } = extractBlocks(text, listed);
    expect(blocks.map((b) => [b.tag, b.body])).toEqual([
      ["telo-edit", "one\n"],
      ["telo-file", "two\n"],
    ]);
  });

  it("does not open a listed fence inside a longer fence of another info string", () => {
    const text = `${fence(4)}text\n${fence(3)}telo-edit path=x\nexample\n${fence(3)}\n${fence(4)}`;
    expect(extractBlocks(text, listed)).toEqual({ blocks: [] });
  });

  it("passes a three-backtick fence inside a four-backtick block as body", () => {
    const body = `# readme\n${fence(3)}yaml\nkind: X\n${fence(3)}\n`;
    const text = `${fence(4)}telo-file path=README.md\n${body}${fence(4)}`;
    expect(extractBlocks(text, listed).blocks[0]!.body).toBe(body);
  });

  it("reports a listed block that never closes, and runs none before it", () => {
    const text = `${fence(3)}telo-edit path=x\na\n${fence(3)}\n${fence(3)}telo-file path=y\npartial`;
    const extracted = extractBlocks(text, listed);
    expect(extracted.open).toEqual({ tag: "telo-file", attributes: [["path", "y"]] });
    expect(extracted.blocks).toHaveLength(1);
  });

  it("reports a listed fence whose attribute does not parse, and reads an unlisted tag as text", () => {
    const quoted = `${fence(3)}telo-file path="a.yaml"\nx\n${fence(3)}`;
    expect(extractBlocks(quoted, listed)).toEqual({
      blocks: [],
      malformed: { tag: "telo-file", token: 'path="a.yaml"' },
    });
    const tabbed = `${fence(3)}telo-file\tpath=a.yaml\nx\n${fence(3)}`;
    expect(extractBlocks(tabbed, listed).malformed).toEqual({ tag: "telo-file", token: "\tpath=a.yaml" });
    expect(extractBlocks(`${fence(3)}yaml path="a"\nx\n${fence(3)}`, listed)).toEqual({ blocks: [] });
  });

  it("closes a block on a backtick line with trailing spaces or tabs", () => {
    const text = `${fence(3)}telo-edit path=x\nbody\n${fence(3)} \t\nafter`;
    expect(extractBlocks(text, listed)).toEqual({
      blocks: [{ tag: "telo-edit", attributes: [["path", "x"]], body: "body\n" }],
    });
  });

  it("closes a fence only on a line of at least as many backticks and nothing else", () => {
    const text = `${fence(4)}telo-edit path=x\n${fence(3)}\n${fence(4)} trailing\n${fence(5)}`;
    expect(extractBlocks(text, listed).blocks[0]!.body).toBe(`${fence(3)}\n${fence(4)} trailing\n`);
  });

  it("matches CRLF fence lines and keeps the body raw", () => {
    const text = `${fence(3)}telo-edit path=x\r\nline\r\n${fence(3)}\r\n`;
    expect(extractBlocks(text, listed).blocks[0]!.body).toBe("line\r\n");
  });
});

describe("textCallId", () => {
  const identity = { text: "reply", tool: "apply", tags: ["b", "a"], arguments: { y: 1, x: [true] } };

  it("is a block_ UUIDv8 that depends only on the content", () => {
    const id = textCallId(identity);
    expect(id).toMatch(/^block_[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(textCallId({ ...identity, tags: ["a", "b"], arguments: { x: [true], y: 1 } })).toBe(id);
    expect(textCallId({ ...identity, arguments: { y: 2, x: [true] } })).not.toBe(id);
    expect(textCallId({ ...identity, arguments: null })).not.toBe(id);
  });

  it("hashes RFC 8785 canonical JSON", () => {
    expect(canonicalJson({ b: [1, "é", null], a: { d: false, c: 1.5 } })).toBe(
      '{"a":{"c":1.5,"d":false},"b":[1,"é",null]}',
    );
  });
});

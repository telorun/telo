import * as dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import {
  appendEnvFileLines,
  appendEnvFileValue,
  clearEnvFileValue,
  parseEnvFile,
  setEnvFileValue,
  spellEnvFileValue,
  type EnvFileEdit,
} from "../src/workspace-env/env-file-format.js";

const values = (text: string) => Object.fromEntries(parseEnvFile(text).map((a) => [a.key, a.value]));

/** Every shape the format's reader has an opinion about. */
const CORPUS: Record<string, string> = {
  plain: "A=1\nB=two words\nC=  padded  \n",
  blank: "EMPTY=\nSPACES=   \nCOMMENTED=   # nothing\n\n\n",
  comments: "# heading\nA=1 # trailing\nB=x#y\n  # indented\nC='# not a comment'\n",
  export: "export A=1\n  export   B = 2\nexportC=3\n",
  colon: "A: 1\nB:2\nC:\n",
  single: "A='it is'\nB='a\\'b'\nC='  kept  '\n",
  double: 'A="line\\nbreak"\nB="tab\\tstays"\nC="cr\\rx"\nD="quote \\" inside"\n',
  backtick: "A=`it's \"both\"`\nB=`\\n stays`\n",
  multiline: 'A="first\nsecond"\nB=\'one\ntwo\'\nC=`x\ny`\nD=after\n',
  unclosed: "A=\"open\nB=2\nC='also open\n",
  crlf: "A=1\r\nB=\"x\r\ny\"\r\nC=3\rD=4\r\n",
  repeated: "A=first\nA=second\n",
  keys: "a.b=1\nc-d=2\ne_f=3\n9g=4\n",
  odd: "  A  =  spaced  \nB=a=b=c\nC==\n=nokey\nnoequals\n",
};

describe("reading an env file", () => {
  it.each(Object.entries(CORPUS))("agrees with dotenv 17 on %s", (_name, text) => {
    expect(values(text)).toEqual(dotenv.parse(text));
  });

  it("reports each assignment's spans in the original text, line breaks included", () => {
    const text = "# c\r\nA = 'x'  # note\r\nB=\"1\n2\"\r\n";
    const [a, b] = parseEnvFile(text);
    expect(text.slice(a.span.start, a.span.end)).toBe("A = 'x'  # note\r\n");
    expect(text.slice(a.valueSpan.start, a.valueSpan.end)).toBe("'x'");
    expect(text.slice(b.span.start, b.span.end)).toBe('B="1\n2"\r\n');
    expect(text.slice(b.valueSpan.start, b.valueSpan.end)).toBe('"1\n2"');
  });
});

describe("spelling a value", () => {
  it.each(["plain", "", "a b", "Hello, # world", '["a b","it\'s"]', "it's `x`", "$HOME", "x\\ny", " padded "])(
    "spells %j so the reader gives it back unchanged",
    (text) => {
      const spelled = spellEnvFileValue(text);
      expect("spelling" in spelled && values(`V=${spelled.spelling}`).V).toBe(text);
    },
  );

  it("refuses a line break and a value no quoting reads back, with the reason", () => {
    expect(spellEnvFileValue("a\nb")).toEqual({ refused: expect.stringContaining("line break") });
    expect(spellEnvFileValue("it's \"x\" `y`")).toEqual({ refused: expect.stringContaining("three quote") });
    expect(spellEnvFileValue("it's `x` \\n")).toEqual({ refused: expect.stringContaining("expand") });
  });
});

describe("editing an env file", () => {
  const text = "# header\r\nexport A = 'old'   # keep me\r\nB=1\r\nA=older\r\n\r\n# footer";
  const ok = (edit: EnvFileEdit): string => {
    if (!edit.ok) throw new Error(edit.reason);
    return edit.text;
  };

  it("sets only the value of the key's last assignment, every other byte unchanged", () => {
    const edited = ok(setEnvFileValue(text, "A", "new value"));
    expect(edited).toBe(text.replace("A=older", "A='new value'"));
    expect(values(edited)).toEqual({ ...values(text), A: "new value" });
  });

  it("sets an empty assignment where its value goes", () => {
    expect(ok(setEnvFileValue("A=   # c\nB=2\n", "A", "x"))).toBe("A=x   # c\nB=2\n");
  });

  it("refuses to set a key the file does not assign, or a value it cannot spell", () => {
    expect(setEnvFileValue(text, "C", "x")).toEqual({ ok: false, reason: "the file does not assign C" });
    expect(setEnvFileValue(text, "A", "a\nb")).toMatchObject({ ok: false, reason: expect.stringContaining("line break") });
  });

  it("appends a line, adding the missing final line break first", () => {
    const edited = ok(appendEnvFileValue(text, "C", "it's"));
    expect(edited).toBe(`${text}\nC=\`it's\`\n`);
    expect(values(edited)).toEqual({ ...values(text), C: "it's" });
    expect(appendEnvFileLines("A=1\n", ["", "# B="])).toBe("A=1\n\n# B=\n");
  });

  it("refuses an edit that would change how another key reads", () => {
    // `A:` with nothing after it takes the next line as its value.
    expect(appendEnvFileValue("A:\n", "C", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("would change how the file reads A"),
    });
  });

  it("clears every assignment of the key, leaving every other line", () => {
    const edited = ok(clearEnvFileValue(text, "A"));
    expect(edited).toBe("# header\r\nB=1\r\n\r\n# footer");
    expect(ok(clearEnvFileValue(edited, "A"))).toBe(edited);
  });
});

/**
 * Reading a `Cargo.toml` into plain data, for the build-input digest of a
 * crate-built source.
 *
 * A strict reader of the TOML cargo manifests are written in — tables, arrays of
 * tables, dotted and quoted keys, strings of all four kinds, arrays, inline
 * tables, booleans, and other scalars kept as their text. Anything else is a
 * refusal naming the line, never a skip: a dependency table read wrongly would
 * drop a path dependency from the digest, and a prebuild would then outlive a
 * change to code it links without anything reporting it.
 */

export type TomlValue = string | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export function parseCargoToml(text: string, where: string): TomlTable {
  return new Reader(text, where).document();
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Reader {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly where: string,
  ) {}

  document(): TomlTable {
    const root: TomlTable = {};
    let current = root;
    for (;;) {
      this.skipBlank(true);
      if (this.pos >= this.text.length) return root;
      if (this.text.startsWith("[[", this.pos)) {
        this.pos += 2;
        const keys = this.keyPath("]]");
        const parent = this.tableAt(root, keys.slice(0, -1));
        const last = keys[keys.length - 1]!;
        const list = parent[last] ?? [];
        if (!Array.isArray(list)) this.fail(`'${keys.join(".")}' is not an array of tables`);
        const table: TomlTable = {};
        list.push(table);
        parent[last] = list;
        current = table;
      } else if (this.text[this.pos] === "[") {
        this.pos += 1;
        current = this.tableAt(root, this.keyPath("]"));
      } else {
        const keys = this.keyPath("=");
        this.skipInline();
        this.assign(current, keys, this.value());
      }
      this.endOfLine();
    }
  }

  private keyPath(terminator: string): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipInline();
      const quote = this.text[this.pos];
      if (quote === '"' || quote === "'") {
        keys.push(this.singleLineString());
      } else {
        const start = this.pos;
        while (this.pos < this.text.length && BARE_KEY.test(this.text[this.pos]!)) this.pos++;
        if (start === this.pos) this.fail("expected a key");
        keys.push(this.text.slice(start, this.pos));
      }
      this.skipInline();
      if (this.text.startsWith(terminator, this.pos)) {
        this.pos += terminator.length;
        return keys;
      }
      if (this.text[this.pos] !== ".") this.fail(`expected '.' or '${terminator}' after a key`);
      this.pos += 1;
    }
  }

  private value(): TomlValue {
    const ch = this.text[this.pos];
    if (this.text.startsWith('"""', this.pos) || this.text.startsWith("'''", this.pos)) {
      return this.multiLineString();
    }
    if (ch === '"' || ch === "'") return this.singleLineString();
    if (ch === "[") return this.array();
    if (ch === "{") return this.inlineTable();
    const start = this.pos;
    while (this.pos < this.text.length && !/[,\]}#\r\n]/.test(this.text[this.pos]!)) this.pos++;
    const token = this.text.slice(start, this.pos).trim();
    if (token === "") this.fail("expected a value");
    if (token === "true") return true;
    if (token === "false") return false;
    return token;
  }

  private array(): TomlValue[] {
    this.pos += 1;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipBlank(true);
      if (this.text[this.pos] === "]") {
        this.pos += 1;
        return out;
      }
      out.push(this.value());
      this.skipBlank(true);
      if (this.text[this.pos] === ",") {
        this.pos += 1;
      } else if (this.text[this.pos] !== "]") {
        this.fail("expected ',' or ']' in an array");
      }
    }
  }

  private inlineTable(): TomlTable {
    this.pos += 1;
    const out: TomlTable = {};
    this.skipInline();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      const keys = this.keyPath("=");
      this.skipInline();
      this.assign(out, keys, this.value());
      this.skipInline();
      if (this.text[this.pos] === "}") {
        this.pos += 1;
        return out;
      }
      if (this.text[this.pos] !== ",") this.fail("expected ',' or '}' in an inline table");
      this.pos += 1;
    }
  }

  private singleLineString(): string {
    const quote = this.text[this.pos]!;
    this.pos += 1;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined || ch === "\n") this.fail("unterminated string");
      this.pos += 1;
      if (ch === quote) return out;
      out += quote === '"' && ch === "\\" ? this.escape() : ch;
    }
  }

  private multiLineString(): string {
    const delimiter = this.text.slice(this.pos, this.pos + 3);
    this.pos += 3;
    if (this.text[this.pos] === "\n") this.pos += 1;
    else if (this.text.startsWith("\r\n", this.pos)) this.pos += 2;
    const end = this.text.indexOf(delimiter, this.pos);
    if (end < 0) this.fail("unterminated multi-line string");
    const body = this.text.slice(this.pos, end);
    this.pos = end + 3;
    // Content matters to no key this reader serves (descriptions), so escapes in
    // a basic multi-line string are kept as written.
    return body;
  }

  private escape(): string {
    const ch = this.text[this.pos];
    this.pos += 1;
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (ch !== undefined && ch in simple) return simple[ch]!;
    if (ch === "u" || ch === "U") {
      const length = ch === "u" ? 4 : 8;
      const hex = this.text.slice(this.pos, this.pos + length);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) this.fail("invalid unicode escape");
      this.pos += length;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return this.fail(`invalid escape '\\${ch ?? ""}'`);
  }

  private tableAt(root: TomlTable, keys: string[]): TomlTable {
    let table = root;
    for (const key of keys) {
      let next = table[key];
      if (next === undefined) {
        next = {};
        table[key] = next;
      }
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        this.fail(`'${keys.join(".")}' is not a table`);
      }
      table = next as TomlTable;
    }
    return table;
  }

  private assign(table: TomlTable, keys: string[], value: TomlValue): void {
    const parent = this.tableAt(table, keys.slice(0, -1));
    const last = keys[keys.length - 1]!;
    if (last in parent) this.fail(`'${keys.join(".")}' is defined twice`);
    parent[last] = value;
  }

  private skipInline(): void {
    while (this.text[this.pos] === " " || this.text[this.pos] === "\t") this.pos++;
  }

  /** Whitespace and comments, across newlines when `lines`. */
  private skipBlank(lines: boolean): void {
    for (;;) {
      this.skipInline();
      const ch = this.text[this.pos];
      if (ch === "#") {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos++;
      } else if (lines && (ch === "\n" || ch === "\r")) {
        this.pos++;
      } else {
        return;
      }
    }
  }

  private endOfLine(): void {
    this.skipBlank(false);
    if (this.pos >= this.text.length) return;
    if (this.text.startsWith("\r\n", this.pos)) this.pos += 2;
    else if (this.text[this.pos] === "\n") this.pos += 1;
    else this.fail("unexpected text after a value");
  }

  private fail(message: string): never {
    const line = this.text.slice(0, this.pos).split("\n").length;
    throw new Error(`${this.where}:${line}: ${message}`);
  }
}

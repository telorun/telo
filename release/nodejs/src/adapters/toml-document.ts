/**
 * A TOML document read into values that keep their source spans, so a caller
 * can splice one string without re-serializing the file. The whole TOML 1.0
 * grammar is read (inline tables may span lines and end in a comma, as TOML 1.1
 * allows); a date or time is kept as its text. Anything else is refused naming
 * the line, never guessed at.
 */

export class TomlError extends Error {}

export type TomlValue =
  | { readonly kind: "string"; readonly value: string; readonly start: number; readonly end: number; readonly quote: "\"" | "'" | "\"\"\"" | "'''" }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number; readonly text: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "datetime"; readonly text: string }
  | { readonly kind: "array"; readonly items: TomlValue[]; readonly ofTables: boolean }
  | TomlTable;

export interface TomlTable {
  readonly kind: "table";
  readonly entries: Map<string, TomlValue>;
  /** An inline table, a table a header defined, or one only named by a dotted key or header path. */
  origin: "inline" | "header" | "dotted" | "implicit";
}

export type TomlString = Extract<TomlValue, { kind: "string" }>;

function table(origin: TomlTable["origin"]): TomlTable {
  return { kind: "table", entries: new Map(), origin };
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Reader {
  pos = 0;
  constructor(
    readonly text: string,
    readonly where: string,
  ) {}

  fail(message: string, at = this.pos): never {
    const line = this.text.slice(0, at).split("\n").length;
    throw new TomlError(`${this.where}:${line}: ${message}`);
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  startsWith(token: string): boolean {
    return this.text.startsWith(token, this.pos);
  }

  skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  skipComment(): void {
    if (this.peek() !== "#") return;
    while (this.pos < this.text.length && this.peek() !== "\n") this.pos++;
  }

  /** Spaces, a comment, then a newline or the end. */
  endOfLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.pos >= this.text.length) return;
    if (this.startsWith("\r\n")) this.pos += 2;
    else if (this.peek() === "\n") this.pos++;
    else this.fail(`expected the end of the line, found '${this.peek()}'`);
  }

  /** Whitespace, newlines and comments, as inside an array. */
  skipBlank(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.startsWith("\r\n")) this.pos += 2;
      else if (this.peek() === "\n") this.pos++;
      else return;
    }
  }

  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipSpaces();
      const quote = this.peek();
      if (quote === '"' || quote === "'") {
        const literal = this.string();
        if (literal.quote.length === 3) this.fail("a key cannot be a multi-line string");
        parts.push(literal.value);
      } else {
        const start = this.pos;
        while (BARE_KEY.test(this.peek())) this.pos++;
        if (this.pos === start) this.fail(`expected a key, found '${this.peek() || "the end"}'`);
        parts.push(this.text.slice(start, this.pos));
      }
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.pos++;
    }
  }

  string(): TomlString {
    const start = this.pos;
    if (this.startsWith('"""')) return this.multiline(start, '"""');
    if (this.startsWith("'''")) return this.multiline(start, "'''");
    const quote = this.peek() as '"' | "'";
    this.pos++;
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === "" || char === "\n") this.fail("a string is not closed on its line", start);
      this.pos++;
      if (char === quote) break;
      if (quote === '"' && char === "\\") value += this.escape();
      else value += char;
    }
    return { kind: "string", value, start, end: this.pos, quote };
  }

  multiline(start: number, quote: '"""' | "'''"): TomlString {
    this.pos += 3;
    if (this.startsWith("\r\n")) this.pos += 2;
    else if (this.peek() === "\n") this.pos++;
    let value = "";
    for (;;) {
      if (this.pos >= this.text.length) this.fail("a multi-line string is not closed", start);
      if (this.startsWith(quote)) {
        // Up to two quotes may sit right before the closing three.
        let extra = 0;
        while (extra < 2 && this.text[this.pos + 3 + extra] === quote[0]) extra++;
        value += quote[0]!.repeat(extra);
        this.pos += 3 + extra;
        return { kind: "string", value, start, end: this.pos, quote };
      }
      const char = this.peek();
      this.pos++;
      if (quote === '"""' && char === "\\") {
        const rest = /^[ \t]*\r?\n/.exec(this.text.slice(this.pos));
        if (rest) {
          this.pos += rest[0].length;
          while (/[ \t\r\n]/.test(this.peek()) && this.pos < this.text.length) this.pos++;
          continue;
        }
        value += this.escape();
      } else value += char;
    }
  }

  escape(): string {
    const char = this.peek();
    this.pos++;
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
    if (char in simple) return simple[char]!;
    const width = char === "u" ? 4 : char === "U" ? 8 : char === "x" ? 2 : 0;
    if (width === 0) this.fail(`'\\${char}' is not an escape a TOML string knows`);
    const hex = this.text.slice(this.pos, this.pos + width);
    if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) this.fail(`'\\${char}${hex}' is not a valid escape`);
    this.pos += width;
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail(`'\\${char}${hex}' names no Unicode scalar value`);
    return String.fromCodePoint(code);
  }

  value(): TomlValue {
    const char = this.peek();
    if (char === '"' || char === "'") return this.string();
    if (char === "[") return this.array();
    if (char === "{") return this.inlineTable();
    const start = this.pos;
    while (this.pos < this.text.length && !/[,\]}\n#\r]/.test(this.peek())) this.pos++;
    const raw = this.text.slice(start, this.pos).replace(/[ \t]+$/, "");
    // Read to the next delimiter, since a local date-time holds a space.
    this.pos = start + raw.length;
    if (raw === "") this.fail(`expected a value, found '${char || "the end"}'`);
    if (raw === "true" || raw === "false") return { kind: "boolean", value: raw === "true" };
    if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw) || /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
      return { kind: "datetime", text: raw };
    }
    const integer = /^[+-]?(0|[1-9](_?\d)*)$/.exec(raw);
    if (integer) return { kind: "integer", value: BigInt(raw.replace(/_/g, "")) };
    if (/^(0x[0-9A-Fa-f](_?[0-9A-Fa-f])*|0o[0-7](_?[0-7])*|0b[01](_?[01])*)$/.test(raw)) {
      return { kind: "integer", value: BigInt(raw.replace(/_/g, "")) };
    }
    if (/^[+-]?(inf|nan)$/.test(raw)) {
      return { kind: "float", value: raw.endsWith("nan") ? NaN : raw.startsWith("-") ? -Infinity : Infinity, text: raw };
    }
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw)) {
      return { kind: "float", value: Number(raw.replace(/_/g, "")), text: raw };
    }
    return this.fail(`'${raw}' is not a TOML value`, start);
  }

  array(): TomlValue {
    this.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") break;
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() !== "]") this.fail(`expected ',' or ']' in an array, found '${this.peek() || "the end"}'`);
      break;
    }
    this.pos++;
    return { kind: "array", items, ofTables: false };
  }

  inlineTable(): TomlTable {
    this.pos++;
    const inline = table("inline");
    for (;;) {
      this.skipBlank();
      if (this.peek() === "}") break;
      const key = this.key();
      this.skipSpaces();
      if (this.peek() !== "=") this.fail(`expected '=' after the key '${key.join(".")}'`);
      this.pos++;
      this.skipSpaces();
      assign(this, inline, key, this.value());
      this.skipBlank();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() !== "}") this.fail(`expected ',' or '}' in an inline table, found '${this.peek() || "the end"}'`);
      break;
    }
    this.pos++;
    return inline;
  }
}

/** `value` stored at `key` beneath `into`, creating the dotted tables between. */
function assign(reader: Reader, into: TomlTable, key: readonly string[], value: TomlValue): void {
  let current = into;
  for (const part of key.slice(0, -1)) {
    const existing = current.entries.get(part);
    if (existing === undefined) {
      const next = table("dotted");
      current.entries.set(part, next);
      current = next;
    } else if (existing.kind === "table" && existing.origin === "dotted") {
      current = existing;
    } else {
      reader.fail(`'${key.join(".")}' extends '${part}', which is already defined as a value`);
    }
  }
  const last = key[key.length - 1]!;
  if (current.entries.has(last)) reader.fail(`'${key.join(".")}' is defined twice`);
  current.entries.set(last, value);
}

/** Read a whole TOML document. */
export function readTomlDocument(text: string, where: string): TomlTable {
  const reader = new Reader(text, where);
  // Spans stay offsets into `text`, which callers splice.
  if (text.startsWith("﻿")) reader.pos = 1;
  const root = table("header");
  let current = root;
  while (reader.pos < reader.text.length) {
    reader.skipSpaces();
    const char = reader.peek();
    if (char === "#" || char === "\n" || char === "\r" || char === "") {
      reader.endOfLine();
      continue;
    }
    if (char === "[") {
      const arrayOfTables = reader.startsWith("[[");
      reader.pos += arrayOfTables ? 2 : 1;
      const key = reader.key();
      if (!reader.startsWith(arrayOfTables ? "]]" : "]")) reader.fail(`a table header is not closed`);
      reader.pos += arrayOfTables ? 2 : 1;
      reader.endOfLine();
      current = arrayOfTables ? appendTable(reader, root, key) : openTable(reader, root, key);
      continue;
    }
    const key = reader.key();
    if (reader.peek() !== "=") reader.fail(`expected '=' after the key '${key.join(".")}'`);
    reader.pos++;
    reader.skipSpaces();
    assign(reader, current, key, reader.value());
    reader.endOfLine();
  }
  return root;
}

/** The table beneath `key`'s parents, each parent made or reached. */
function parentOf(reader: Reader, root: TomlTable, key: readonly string[]): TomlTable {
  let current = root;
  for (const part of key.slice(0, -1)) {
    const existing = current.entries.get(part);
    if (existing === undefined) {
      const next = table("implicit");
      current.entries.set(part, next);
      current = next;
    } else if (existing.kind === "table" && existing.origin !== "inline") {
      current = existing;
    } else if (existing.kind === "array" && existing.ofTables) {
      current = existing.items[existing.items.length - 1] as TomlTable;
    } else {
      reader.fail(`the header '${key.join(".")}' passes through '${part}', which is not a table`);
    }
  }
  return current;
}

function openTable(reader: Reader, root: TomlTable, key: readonly string[]): TomlTable {
  const parent = parentOf(reader, root, key);
  const last = key[key.length - 1]!;
  const existing = parent.entries.get(last);
  if (existing === undefined) {
    const made = table("header");
    parent.entries.set(last, made);
    return made;
  }
  if (existing.kind === "table" && existing.origin === "implicit") {
    existing.origin = "header";
    return existing;
  }
  return reader.fail(`the table '${key.join(".")}' is defined twice`);
}

function appendTable(reader: Reader, root: TomlTable, key: readonly string[]): TomlTable {
  const parent = parentOf(reader, root, key);
  const last = key[key.length - 1]!;
  const existing = parent.entries.get(last);
  const made = table("header");
  if (existing === undefined) {
    parent.entries.set(last, { kind: "array", items: [made], ofTables: true });
    return made;
  }
  if (existing.kind === "array" && existing.ofTables) {
    existing.items.push(made);
    return made;
  }
  return reader.fail(`'${key.join(".")}' is not an array of tables`);
}

/** The value at `path` beneath `from`, or `undefined` when any step is absent
 *  or not a table. */
export function tomlAt(from: TomlTable, path: readonly string[]): TomlValue | undefined {
  let current: TomlValue | undefined = from;
  for (const part of path) {
    if (current?.kind !== "table") return undefined;
    current = current.entries.get(part);
  }
  return current;
}

/** The text a TOML basic string literal spelling `value` is written as. */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

/**
 * The text of a string literal rewritten to hold `value`, in its author's quote
 * style where that style can hold it: a literal string or a basic one with no
 * escape is spliced as written; anything else becomes a basic string.
 */
export function respellTomlString(text: string, literal: TomlString, value: string): string {
  const q = literal.quote;
  const inner = text.slice(literal.start + q.length, literal.end - q.length);
  const controls = /[\u0000-\u001f\u007f]/.test(value);
  if (q === "'" && !controls && !value.includes("'")) return `'${value}'`;
  if (q === '"' && !controls && !inner.includes("\\") && !value.includes('"') && !value.includes("\\")) return `"${value}"`;
  return tomlBasicString(value);
}

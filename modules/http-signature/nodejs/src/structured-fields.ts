/** RFC 9651 Structured Field Values: the Dictionary subset the signature headers use, read and written. */

export type BareItem =
  | { type: "integer"; value: number }
  | { type: "decimal"; value: number }
  | { type: "string"; value: string }
  | { type: "token"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: number }
  | { type: "display"; value: string };

export type Parameters = Array<[string, BareItem]>;
export interface Item { value: BareItem; params: Parameters }
export interface InnerList { items: Item[]; params: Parameters }
export type Member = Item | InnerList;
export type Dictionary = Map<string, Member>;

export class StructuredFieldError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
  }
}

export function isInnerList(member: Member): member is InnerList {
  return "items" in member;
}

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const DIGIT = /[0-9]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

class Reader {
  at = 0;
  constructor(readonly text: string) {}

  eof(): boolean { return this.at >= this.text.length; }
  peek(): string | undefined { return this.text[this.at]; }
  fail(message: string): never { throw new StructuredFieldError(message, this.at); }
  skipSp(): void { while (this.peek() === " ") this.at++; }
  skipOws(): void { while (this.peek() === " " || this.peek() === "\t") this.at++; }

  key(): string {
    const first = this.peek();
    if (first === undefined || !KEY_START.test(first)) this.fail("expected a key");
    const start = this.at++;
    while (!this.eof() && KEY_CHAR.test(this.text[this.at]!)) this.at++;
    return this.text.slice(start, this.at);
  }

  params(): Parameters {
    const out: Parameters = [];
    while (this.peek() === ";") {
      this.at++;
      this.skipSp();
      const key = this.key();
      let value: BareItem = { type: "boolean", value: true };
      if (this.peek() === "=") {
        this.at++;
        value = this.bareItem();
      }
      const existing = out.findIndex(([name]) => name === key);
      if (existing >= 0) out[existing] = [key, value];
      else out.push([key, value]);
    }
    return out;
  }

  bareItem(): BareItem {
    const c = this.peek();
    if (c === undefined) this.fail("expected an item");
    if (c === "-" || DIGIT.test(c)) return this.number();
    if (c === '"') return { type: "string", value: this.string() };
    if (c === ":") return this.bytes();
    if (c === "?") return this.boolean();
    if (c === "@") {
      this.at++;
      const n = this.number();
      if (n.type !== "integer") this.fail("a date must be an integer");
      return { type: "date", value: n.value };
    }
    if (c === "%") return this.displayString();
    if (TOKEN_START.test(c)) {
      const start = this.at++;
      while (!this.eof() && TOKEN_CHAR.test(this.text[this.at]!)) this.at++;
      return { type: "token", value: this.text.slice(start, this.at) };
    }
    return this.fail(`unexpected character '${c}'`);
  }

  number(): BareItem {
    const start = this.at;
    if (this.peek() === "-") this.at++;
    const digitsStart = this.at;
    while (!this.eof() && DIGIT.test(this.text[this.at]!)) this.at++;
    if (this.at === digitsStart) this.fail("expected digits");
    let decimal = false;
    if (this.peek() === ".") {
      if (this.at - digitsStart > 12) this.fail("a decimal's integer part has at most 12 digits");
      decimal = true;
      this.at++;
      const fractionStart = this.at;
      while (!this.eof() && DIGIT.test(this.text[this.at]!)) this.at++;
      const fraction = this.at - fractionStart;
      if (fraction < 1 || fraction > 3) this.fail("a decimal has one to three fraction digits");
    } else if (this.at - digitsStart > 15) {
      this.fail("an integer has at most 15 digits");
    }
    const value = Number(this.text.slice(start, this.at));
    return decimal ? { type: "decimal", value } : { type: "integer", value };
  }

  string(): string {
    this.at++;
    let out = "";
    while (!this.eof()) {
      const c = this.text[this.at++]!;
      if (c === "\\") {
        const next = this.text[this.at++];
        if (next !== '"' && next !== "\\") this.fail("invalid escape in a string");
        out += next;
      } else if (c === '"') {
        return out;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) this.fail("a string holds only printable ASCII");
        out += c;
      }
    }
    return this.fail("unterminated string");
  }

  bytes(): BareItem {
    this.at++;
    const end = this.text.indexOf(":", this.at);
    if (end < 0) this.fail("unterminated byte sequence");
    const encoded = this.text.slice(this.at, end);
    if (!BASE64.test(encoded)) this.fail("a byte sequence is base64");
    this.at = end + 1;
    return { type: "bytes", value: new Uint8Array(Buffer.from(encoded, "base64")) };
  }

  boolean(): BareItem {
    this.at++;
    const c = this.text[this.at++];
    if (c === "1") return { type: "boolean", value: true };
    if (c === "0") return { type: "boolean", value: false };
    return this.fail("a boolean is ?0 or ?1");
  }

  displayString(): BareItem {
    this.at++;
    if (this.text[this.at++] !== '"') this.fail('a display string starts with %"');
    const bytes: number[] = [];
    while (!this.eof()) {
      const c = this.text[this.at++]!;
      if (c === '"') {
        try {
          return { type: "display", value: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)) };
        } catch {
          return this.fail("a display string is UTF-8");
        }
      }
      if (c === "%") {
        const hex = this.text.slice(this.at, this.at + 2);
        if (!/^[0-9a-f]{2}$/.test(hex)) this.fail("invalid percent escape");
        this.at += 2;
        bytes.push(parseInt(hex, 16));
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) this.fail("a display string holds printable ASCII or escapes");
        bytes.push(code);
      }
    }
    return this.fail("unterminated display string");
  }

  item(): Item {
    const value = this.bareItem();
    return { value, params: this.params() };
  }

  innerList(): InnerList {
    this.at++;
    const items: Item[] = [];
    for (;;) {
      this.skipSp();
      if (this.peek() === ")") {
        this.at++;
        return { items, params: this.params() };
      }
      if (this.eof()) this.fail("unterminated inner list");
      items.push(this.item());
      const next = this.peek();
      if (next !== " " && next !== ")") this.fail("expected a space or ')'");
    }
  }
}

/** Reads a Dictionary field value; a later member of a repeated key replaces the earlier. */
export function parseDictionary(text: string): Dictionary {
  const reader = new Reader(text);
  const out: Dictionary = new Map();
  reader.skipSp();
  while (!reader.eof()) {
    const key = reader.key();
    let member: Member;
    if (reader.peek() === "=") {
      reader.at++;
      member = reader.peek() === "(" ? reader.innerList() : reader.item();
    } else {
      member = { value: { type: "boolean", value: true }, params: reader.params() };
    }
    out.set(key, member);
    reader.skipOws();
    if (reader.eof()) break;
    if (reader.peek() !== ",") reader.fail("expected ','");
    reader.at++;
    reader.skipOws();
    if (reader.eof()) reader.fail("trailing comma");
  }
  return out;
}

/** Reads one Item (a bare item with parameters) and nothing more. */
export function parseItem(text: string): Item {
  const reader = new Reader(text);
  reader.skipSp();
  const item = reader.item();
  reader.skipSp();
  if (!reader.eof()) reader.fail("unexpected trailing text");
  return item;
}

function serializeBare(item: BareItem): string {
  switch (item.type) {
    case "integer": return String(item.value);
    case "decimal": {
      const fixed = item.value.toFixed(3).replace(/0+$/, "");
      return fixed.endsWith(".") ? `${fixed}0` : fixed;
    }
    case "string": return `"${item.value.replace(/[\\"]/g, "\\$&")}"`;
    case "token": return item.value;
    case "bytes": return `:${Buffer.from(item.value).toString("base64")}:`;
    case "boolean": return item.value ? "?1" : "?0";
    case "date": return `@${item.value}`;
    case "display": {
      let out = '%"';
      for (const byte of new TextEncoder().encode(item.value)) {
        out += byte === 0x25 || byte === 0x22 || byte < 0x20 || byte > 0x7e ? `%${byte.toString(16).padStart(2, "0")}` : String.fromCharCode(byte);
      }
      return `${out}"`;
    }
  }
}

export function serializeParameters(params: Parameters): string {
  return params.map(([key, value]) => (value.type === "boolean" && value.value ? `;${key}` : `;${key}=${serializeBare(value)}`)).join("");
}

export function serializeItem(item: Item): string {
  return serializeBare(item.value) + serializeParameters(item.params);
}

export function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(" ")})${serializeParameters(list.params)}`;
}

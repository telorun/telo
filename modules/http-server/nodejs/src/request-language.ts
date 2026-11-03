import type { ApplicationTranslations, TextRecord } from "@telorun/sdk";
import type { FastifyReply } from "fastify";
import type { HeaderReads } from "./request-header-reads.js";

/** The tags of an `Accept-Language` header by quality, best first. A malformed entry,
 *  `*` and a zero quality are skipped; whether a tag is served is for the negotiation. */
export function acceptedLanguages(header: string | string[] | undefined): string[] {
  const text = Array.isArray(header) ? header.join(",") : header;
  if (!text) return [];
  const entries: Array<{ tag: string; q: number; order: number }> = [];
  text.split(",").forEach((part, order) => {
    const [tag, ...params] = part.split(";").map((piece) => piece.trim());
    if (!tag || tag === "*") return;
    let q = 1;
    for (const param of params) {
      const match = /^q=(\d(?:\.\d{0,3})?)$/i.exec(param);
      if (!match) {
        if (/^q=/i.test(param)) return;
        continue;
      }
      q = Number(match[1]);
    }
    if (q > 0 && q <= 1) entries.push({ tag, q, order });
  });
  return entries.sort((a, b) => b.q - a.q || a.order - b.order).map((entry) => entry.tag);
}

/** A header name as HTTP writes it: `accept-language` becomes `Accept-Language`. */
function headerCase(name: string): string {
  return name.replace(/(?:^|-)[a-z]/g, (start) => start.toUpperCase());
}

/**
 * One request's language: negotiated once, handed to every context the request
 * evaluates as `request.lang`. Reading it — or showing a text in it — is what makes
 * the response vary by it, so only then, and only when more than one language is
 * served, does the response carry `Content-Language` and `Vary`.
 */
export class RequestLanguage {
  private wasRead = false;

  constructor(
    private readonly tag: string,
    private readonly reply: FastifyReply,
    private readonly translations: ApplicationTranslations,
    private readonly varies: boolean,
    private readonly preferenceReads: HeaderReads,
  ) {}

  /** The tag, recording that the response now depends on it. */
  get lang(): string {
    this.markRead();
    return this.tag;
  }

  /** `record` shown in this request's language. */
  show(record: TextRecord | undefined): TextRecord | undefined {
    if (!record) return record;
    this.markRead();
    return this.translations.translate(this.tag, record);
  }

  /** Sets the headers when the response depends on the language. Idempotent. */
  apply(): void {
    if (!this.varies || !this.wasRead || this.reply.raw.headersSent) return;
    this.reply.header("Content-Language", this.tag);
    this.reply.header("Vary", this.vary());
  }

  private markRead(): void {
    this.wasRead = true;
    this.apply();
  }

  private vary(): string {
    const existing = this.reply.getHeader("vary");
    const tokens = new Map<string, string>();
    const add = (token: string) => tokens.set(token.toLowerCase(), token);
    (Array.isArray(existing) ? existing.join(",") : String(existing ?? ""))
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach(add);
    add("Accept-Language");
    if (this.preferenceReads === "*") add("*");
    else for (const name of this.preferenceReads) add(headerCase(name));
    return tokens.has("*") ? "*" : [...tokens.values()].join(", ");
  }
}

/** A context's `request` object carrying `lang`, read through `read` so that
 *  evaluating an expression which never touches it records nothing. It is
 *  non-enumerable: the kernel copies a scope's enumerable members when it binds
 *  one, which would read it for every expression. */
export function withLang<T extends object>(request: T, read: () => string): T & { lang: string } {
  return Object.defineProperty(request, "lang", {
    get: read,
    enumerable: false,
    configurable: true,
  }) as T & { lang: string };
}

import {
  durationNanos,
  integerInput,
  InvokeError,
  isCelDuration,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { createTransport } from "nodemailer";
import type { MailAddress, MailMessage, MailSendResult } from "./mail-message.js";
import { bareAddress } from "./mail-message.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const NANOS_PER_MILLISECOND = 1_000_000n;

interface SmtpResource {
  metadata: { name: string; module?: string };
  host: string;
  port?: unknown;
  secure: boolean;
  starttls: "require" | "opportunistic" | "never";
  auth?: { user: string; pass: string };
  from: MailAddress;
  pool?: { maxConnections?: unknown; maxMessages?: unknown };
  timeout?: unknown;
}

type SmtpMailer = ReturnType<typeof createSmtpMailer>;

/** What nodemailer attaches to a failed send. */
interface SmtpFailure {
  message?: string;
  code?: string;
  responseCode?: number;
  response?: string;
}

/** Nodemailer codes for something the server or the envelope refused rather than
 *  a connection that failed. */
const REFUSAL_CODES = new Set(["EENVELOPE", "EMESSAGE", "EAUTH", "ENOAUTH", "EMAXRECIPIENTS"]);

function createSmtpMailer(resource: SmtpResource, label: () => string) {
  const timeoutMs = timeoutInput(resource.timeout, () => `${label()}: 'timeout'`);
  return createTransport({
    pool: true,
    host: resource.host,
    port: optionalInteger(resource.port, () => `${label()}: 'port'`),
    secure: resource.secure,
    requireTLS: !resource.secure && resource.starttls === "require",
    ignoreTLS: !resource.secure && resource.starttls === "never",
    auth: resource.auth ? { user: resource.auth.user, pass: resource.auth.pass } : undefined,
    maxConnections: optionalInteger(resource.pool?.maxConnections, () => `${label()}: 'pool.maxConnections'`),
    maxMessages: optionalInteger(resource.pool?.maxMessages, () => `${label()}: 'pool.maxMessages'`),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    // Every attachment arrives as bytes; nothing in a message may make the
    // transport read a file or fetch a URL.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function optionalInteger(value: unknown, describe: () => string): number | undefined {
  if (value === undefined) return undefined;
  const integer = integerInput(value);
  if (integer === undefined) throw new Error(`${describe()} must be an integer`);
  return integer;
}

function timeoutInput(value: unknown, describe: () => string): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!isCelDuration(value)) throw new Error(`${describe()} must be a duration`);
  const ms = Number(durationNanos(value) / NANOS_PER_MILLISECOND);
  if (ms <= 0) {
    throw new InvokeError(
      "ERR_MAIL_SMTP_TIMEOUT_NOT_POSITIVE",
      `${describe()} must be longer than zero`,
    );
  }
  return ms;
}

function failureCode(failure: SmtpFailure): "ERR_MAIL_REJECTED" | "ERR_MAIL_UNAVAILABLE" {
  const status = failure.responseCode;
  // 4yz is transient by RFC 5321, and 503 says the session was out of step rather
  // than that the message was refused.
  if (status !== undefined && ((status >= 400 && status < 500) || status === 503)) {
    return "ERR_MAIL_UNAVAILABLE";
  }
  if (status !== undefined && status >= 500 && status < 600) return "ERR_MAIL_REJECTED";
  if (failure.code !== undefined && REFUSAL_CODES.has(failure.code)) return "ERR_MAIL_REJECTED";
  return "ERR_MAIL_UNAVAILABLE";
}

/** Mail.Smtp — one pooled nodemailer transport per resource. */
class MailSmtp implements ResourceInstance<MailMessage, MailSendResult> {
  private mailer: SmtpMailer | undefined;

  constructor(private readonly resource: SmtpResource) {}

  private label(): string {
    return `Mail.Smtp "${this.resource.metadata.name}"`;
  }

  init(ctx: ResourceContext) {
    return ctx.effect("smtp connection pool", async () => {
      const mailer = createSmtpMailer(this.resource, () => this.label());
      this.mailer = mailer;
      return {
        result: undefined,
        inverse: () => {
          this.mailer = undefined;
          mailer.close();
        },
      };
    });
  }

  async invoke(message: MailMessage): Promise<MailSendResult> {
    const mailer = this.mailer;
    if (!mailer) throw new Error(`${this.label()} was invoked before it started`);
    const server = `${this.resource.host}${this.resource.port === undefined ? "" : `:${String(this.resource.port)}`}`;
    try {
      const info = await mailer.sendMail({
        from: message.from ?? this.resource.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
        attachments: message.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: Buffer.from(
            attachment.content.buffer,
            attachment.content.byteOffset,
            attachment.content.byteLength,
          ),
          contentType: attachment.contentType,
        })),
      });
      return {
        messageId: info.messageId,
        accepted: info.accepted.map(recipientAddress),
        rejected: info.rejected.map(recipientAddress),
      };
    } catch (error) {
      const failure = (typeof error === "object" && error !== null ? error : {}) as SmtpFailure;
      const reason = failure.response ?? failure.message ?? String(error);
      throw new InvokeError(
        failureCode(failure),
        `${this.label()}: sending through ${server} failed: ${reason}`,
        undefined,
        { cause: error },
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** Nodemailer reports a recipient as its address string, or as an address object
 *  from a custom envelope. */
function recipientAddress(recipient: unknown): string {
  if (typeof recipient === "string") return bareAddress(recipient);
  if (typeof recipient === "object" && recipient !== null && "address" in recipient) {
    return String((recipient as { address: unknown }).address);
  }
  return String(recipient);
}

export async function create(resource: SmtpResource): Promise<MailSmtp> {
  return new MailSmtp(resource);
}

/** An address as the contract accepts it: a bare address or one with a display name. */
export type MailAddress = string | { name: string; address: string };

export interface MailAttachment {
  filename: string;
  content: Uint8Array;
  contentType?: string;
}

/** `Mail.Transport`'s input contract, already validated by the kernel. */
export interface MailMessage {
  from?: MailAddress;
  to: MailAddress | MailAddress[];
  cc?: MailAddress | MailAddress[];
  bcc?: MailAddress | MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
}

export interface MailSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export function addressList(value: MailAddress | MailAddress[] | undefined): MailAddress[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const ANGLE_ADDRESS = /<([^<>]+)>\s*$/;

/** The email address alone: an object's `address`, or a string's `<…>` part when
 *  it is written `Name <address>`. */
export function bareAddress(value: MailAddress): string {
  if (typeof value !== "string") return value.address.trim();
  const angle = ANGLE_ADDRESS.exec(value);
  return (angle ? angle[1] : value).trim();
}

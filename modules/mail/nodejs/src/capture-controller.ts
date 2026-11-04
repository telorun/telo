import type { ResourceInstance } from "@telorun/sdk";
import { randomUUID } from "node:crypto";
import {
  addressList,
  bareAddress,
  type MailMessage,
  type MailSendResult,
} from "./mail-message.js";

export type CapturedMessage = MailMessage & { messageId: string };

/** Mail.Capture — records every message in memory, in the order it was sent. */
export class MailCapture implements ResourceInstance<MailMessage, MailSendResult> {
  private readonly recorded: CapturedMessage[] = [];

  async invoke(message: MailMessage): Promise<MailSendResult> {
    const messageId = `<${randomUUID()}@capture.mail.telo>`;
    this.recorded.push({ messageId, ...message });
    const accepted = [...addressList(message.to), ...addressList(message.cc), ...addressList(message.bcc)]
      .map(bareAddress);
    return { messageId, accepted, rejected: [] };
  }

  messages(): readonly CapturedMessage[] {
    return this.recorded;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export interface CaptureLog {
  messages(): readonly CapturedMessage[];
}

export function isCaptureLog(value: unknown): value is CaptureLog {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<CaptureLog>).messages === "function"
  );
}

export async function create(): Promise<MailCapture> {
  return new MailCapture();
}

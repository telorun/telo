import type { ResourceInstance } from "@telorun/sdk";
import { randomUUID } from "node:crypto";
import type { SmsMessage, SmsSendResult } from "./sms-message.js";

export type CapturedMessage = SmsMessage & { messageId: string };

/** Sms.Capture — records every message in memory, in the order it was sent. */
export class SmsCapture implements ResourceInstance<SmsMessage, SmsSendResult> {
  private readonly recorded: CapturedMessage[] = [];

  async invoke(message: SmsMessage): Promise<SmsSendResult> {
    const messageId = `capture-${randomUUID()}`;
    this.recorded.push({ messageId, ...message });
    return { messageId, status: "sent" };
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

export async function create(): Promise<SmsCapture> {
  return new SmsCapture();
}

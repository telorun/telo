/** `Sms.Transport`'s input contract, already validated by the kernel. */
export interface SmsMessage {
  to: string;
  from?: string;
  text: string;
}

export interface SmsSendResult {
  messageId: string;
  status: "queued" | "sent";
}

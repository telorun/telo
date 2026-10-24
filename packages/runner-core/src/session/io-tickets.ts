import { randomBytes } from "node:crypto";

import { IO_TICKET_TTL_MS, type IoTicket } from "../contract.js";

interface HeldTicket {
  sessionId: string;
  app: string;
  expiresAt: number;
}

/**
 * Single-use tickets for the byte channel. A browser cannot set a header on a
 * WebSocket upgrade, so `/io` takes a ticket minted by an authenticated request
 * instead of a credential — and a credential never appears in a URL.
 */
export class IoTickets {
  private readonly held = new Map<string, HeldTicket>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(sessionId: string, app: string): IoTicket {
    const now = this.now();
    for (const [ticket, held] of this.held) {
      if (held.expiresAt <= now) this.held.delete(ticket);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + IO_TICKET_TTL_MS;
    this.held.set(ticket, { sessionId, app, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The app a ticket admits to on `sessionId`, or undefined. Any presentation
   *  consumes the ticket, so it is refused the second time whatever the first
   *  answer was. */
  redeem(ticket: string, sessionId: string): string | undefined {
    const held = this.held.get(ticket);
    if (!held) return undefined;
    this.held.delete(ticket);
    if (held.sessionId !== sessionId || held.expiresAt <= this.now()) return undefined;
    return held.app;
  }

  /** Drop every ticket of a deleted session. */
  forget(sessionId: string): void {
    for (const [ticket, held] of this.held) {
      if (held.sessionId === sessionId) this.held.delete(ticket);
    }
  }
}

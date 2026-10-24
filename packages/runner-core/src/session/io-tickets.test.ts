import { describe, expect, it } from "vitest";

import { IO_TICKET_TTL_MS } from "../contract.js";
import { IoTickets } from "./io-tickets.js";

describe("IoTickets", () => {
  it("admits a ticket once, on its own session, before it expires", () => {
    let now = 0;
    const tickets = new IoTickets(() => now);
    const used = tickets.mint("s1", "web").ticket;
    const elsewhere = tickets.mint("s1", "web").ticket;
    const late = tickets.mint("s1", "web").ticket;

    expect(tickets.redeem(used, "s1")).toBe("web");
    expect(tickets.redeem(used, "s1")).toBeUndefined();
    expect(tickets.redeem(elsewhere, "s2")).toBeUndefined();
    expect(tickets.redeem(elsewhere, "s1")).toBeUndefined();
    now = IO_TICKET_TTL_MS;
    expect(tickets.redeem(late, "s1")).toBeUndefined();
  });
});

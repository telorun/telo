import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentIdentity, AgentIdentityState } from "@/agent";
import { AgentIdentityDetails, NoAuthBadge, NoTestRunsBadge, UnsupportedFeatures } from "./AgentIdentity";

afterEach(() => {
  cleanup();
});

const known = (auth: string): AgentIdentityState => ({
  state: "known",
  identity: { name: "AuthoringAgent", version: "0.9.0", promptId: "0d21fb58", auth },
});

describe("agent identity", () => {
  it("badges an agent that takes no token, and only that one", () => {
    const badge = (identity: AgentIdentityState | null) => {
      const { container } = render(<NoAuthBadge identity={identity} />);
      const text = container.textContent;
      cleanup();
      return text;
    };

    expect(badge(known("none"))).toBe("No auth");
    expect(badge(known("bearer"))).toBe("");
    expect(badge({ state: "unavailable" })).toBe("");
    expect(badge(null)).toBe("");
  });

  it("shows name, version and prompt id, or says why it cannot", () => {
    render(<AgentIdentityDetails identity={known("bearer")} />);
    expect(screen.getByText("AuthoringAgent")).toBeTruthy();
    expect(screen.getByText("0.9.0")).toBeTruthy();
    expect(screen.getByText("0d21fb58")).toBeTruthy();
    cleanup();

    const said = (identity: AgentIdentityState) => {
      const { container } = render(<AgentIdentityDetails identity={identity} />);
      const text = container.textContent;
      cleanup();
      return text;
    };
    expect(said({ state: "unavailable" })).toBe("Agent identity unavailable.");
    expect(said({ state: "unauthorized" })).toBe("This agent requires a token.");
  });

  it("badges an agent that may not run manifests, and lists what an agent does not support", () => {
    const withRuns = (manifestRuns: boolean | undefined): AgentIdentityState => ({
      state: "known",
      identity: { ...(known("bearer") as { identity: AgentIdentity }).identity, manifestRuns },
    });
    const text = (node: React.ReactElement) => {
      const { container } = render(node);
      const said = container.textContent;
      cleanup();
      return said;
    };

    expect(text(<NoTestRunsBadge identity={withRuns(false)} />)).toBe("No test runs");
    expect(text(<NoTestRunsBadge identity={withRuns(true)} />)).toBe("");
    expect(text(<NoTestRunsBadge identity={withRuns(undefined)} />)).toBe("");

    const partial: AgentIdentityState = {
      state: "known",
      identity: { name: "A", version: "1", promptId: "p", auth: "bearer", features: ["conversations", "later-thing"] },
    };
    expect(text(<UnsupportedFeatures identity={partial} />)).toBe(
      "Not supported by this agent:Retry, edit & resend, delete from hereBranching a conversation",
    );
    expect(text(<UnsupportedFeatures identity={{ state: "unavailable" }} />)).toContain(
      "Conversation list, search and export",
    );
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenUrlRequest } from "../run/open-url-request";
import { OpenUrlDialog } from "./OpenUrlDialog";

const answerOpenUrl = vi.fn();
let requests: OpenUrlRequest[] = [];

vi.mock("../run", () => ({ useRun: () => ({ openUrlRequests: requests, answerOpenUrl }) }));

const base: OpenUrlRequest = {
  id: "r1|http://runner.test:3000/x",
  recordId: "r1",
  appPath: "/w/a/telo.yaml",
  app: "api",
  reach: "port",
  address: "http://runner.test:3000/x",
  host: "runner.test:3000",
  mode: "confirm",
};

afterEach(() => {
  cleanup();
  answerOpenUrl.mockClear();
});

describe("OpenUrlDialog", () => {
  it("names the app and the address, and Open answers once", async () => {
    requests = [base];
    render(<OpenUrlDialog />);

    expect(screen.getByText("Open api in another tab?")).toBeTruthy();
    expect(screen.getByText(base.address)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(answerOpenUrl).toHaveBeenCalledOnce();
    expect(answerOpenUrl).toHaveBeenCalledWith(base.id, { open: true, always: false });
  });

  it("Not now and Escape leave without opening", async () => {
    requests = [base];
    render(<OpenUrlDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await userEvent.keyboard("{Escape}");

    expect(answerOpenUrl).toHaveBeenCalledWith(base.id, { open: false });
    expect(answerOpenUrl.mock.calls.every(([, answer]) => answer.open === false)).toBe(true);
  });

  it("passes 'always' with Open when the box is ticked", async () => {
    requests = [base];
    render(<OpenUrlDialog />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Always open this app" }));
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(answerOpenUrl).toHaveBeenCalledWith(base.id, { open: true, always: true });
  });

  it("shows an external host and offers no 'always'", () => {
    requests = [{ ...base, reach: "external", address: "https://example.org/p", host: "example.org" }];
    render(<OpenUrlDialog />);

    expect(screen.getByText("example.org")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

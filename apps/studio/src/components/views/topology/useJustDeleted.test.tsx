// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { useJustDeleted } from "./useJustDeleted";

const viewData = { manifest: { resources: [] } } as never;

describe("useJustDeleted", () => {
  it("reports a failed delete once and does not reject", async () => {
    const { result } = renderHook(() =>
      useJustDeleted(null, viewData, () => Promise.reject(new Error("disk full"))),
    );
    await act(async () => {
      await result.current.deleteResource("K", "a");
    });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Could not delete a", { description: "disk full" });
  });
});

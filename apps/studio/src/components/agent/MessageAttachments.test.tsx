import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Attachment } from "@/agent";
import { AttachmentLoaderContext, MessageAttachments } from "./MessageAttachments";

const image: Attachment = { id: "a1", name: "shot.png", mediaType: "image/png", size: 2048 };
const manifest: Attachment = { id: "a2", name: "telo.yaml", mediaType: "application/yaml", size: 23 };

let revoked: string[];
beforeEach(() => {
  revoked = [];
  let made = 0;
  // jsdom has neither.
  URL.createObjectURL = () => `blob:studio/${++made}`;
  URL.revokeObjectURL = (url) => void revoked.push(url);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

const renderWith = (load: (attachment: Attachment) => Promise<Blob>, attachments = [image, manifest]) =>
  render(
    <AttachmentLoaderContext.Provider value={load}>
      <MessageAttachments attachments={attachments} />
    </AttachmentLoaderContext.Provider>,
  );

describe("a user message's attachments", () => {
  it("shows an image as a thumbnail read through the agent client, opening larger, its URL revoked on leaving", async () => {
    const load = vi.fn(async (attachment: Attachment) => new Blob(["bytes"], { type: attachment.mediaType }));
    const view = renderWith(load);

    const thumbnail = await screen.findByRole<HTMLImageElement>("img", { name: "shot.png" });
    expect(thumbnail.src).toBe("blob:studio/1");
    expect(load).toHaveBeenCalledWith(image);

    await userEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole<HTMLImageElement>("img", { name: "shot.png" }).src).toBe("blob:studio/1");

    view.unmount();
    expect(revoked).toEqual(["blob:studio/1"]);
  });

  it("names an image whose bytes could not be read, with its size", async () => {
    renderWith(async () => Promise.reject(new Error("not found (ERR_ATTACHMENT_NOT_FOUND)")), [image]);

    const chip = await screen.findByText("shot.png · 2 KB");
    expect(chip.parentElement?.title).toBe("Could not be loaded: not found (ERR_ATTACHMENT_NOT_FOUND)");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("downloads any other file under its name", async () => {
    const load = vi.fn(async () => new Blob(["kind: Telo.Application\n"]));
    const clicked: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
    renderWith(load, [manifest]);

    await userEvent.click(screen.getByRole("button", { name: /telo\.yaml · 23 B/ }));

    await waitFor(() => expect(clicked).toEqual([{ download: "telo.yaml", href: "blob:studio/1" }]));
    expect(load).toHaveBeenCalledWith(manifest);
  });
});

import { createContext, useContext, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { useHostStore } from "../host.js";
import type { MediaItem } from "../media-viewer.js";
import { attachmentAddress, partName, type Block, type SentFile } from "./chat-blocks.js";
import type { Entry } from "./chat-protocol.js";

/** The `basePath` of the endpoint whose transcript is drawn, which a relative attachment reference resolves under. */
export const BasePathContext = createContext("");

/** Opens the viewer at a picture of the transcript, by its id. */
export const ViewerContext = createContext<(id: string) => void>(() => undefined);

/** A picture of the conversation, in the order the transcript draws it. */
export interface Picture extends MediaItem {
  id: string;
}

/** Where an attachment's address is read from: the host's address for an app-relative one, else nowhere. */
export type MediaSource = (url: string) => string | undefined;

/** Reads attachments of the endpoint at `basePath`, whose relative references resolve under it. */
export function useMediaSource(basePath: string): MediaSource {
  const store = useHostStore();
  return useMemo(
    () => (url) => {
      const address = attachmentAddress(basePath, url);
      return address.startsWith("/") ? store.localHref(address) : undefined;
    },
    [store, basePath],
  );
}

/** Reads attachments of the endpoint a chat above this draws. */
export const useChatMediaSource = (): MediaSource => useMediaSource(useContext(BasePathContext));

/** The ids tell where a picture stands: a stored entry's part, the live turn's block, or a file the live user message sent. */
export const entryPictureId = (entry: string, index: number) => `e:${entry}:${index}`;
export const livePictureId = (index: number) => `l:${index}`;
export const sentPictureId = (index: number) => `u:${index}`;

/** The pictures among a stored entry's parts. */
export function entryPictures(entry: Entry, source: MediaSource): Picture[] {
  return entry.parts.flatMap((part, index) => {
    if (part.type !== "image") return [];
    const media = part as { url: string; name?: string };
    const src = source(media.url);
    return src === undefined ? [] : [{ id: entryPictureId(entry.id, index), src, name: partName(media) }];
  });
}

/** The pictures among the blocks of the live turn. */
export function livePictures(blocks: readonly Block[], source: MediaSource): Picture[] {
  return blocks.flatMap((block, index) => {
    if (block.kind !== "part" || block.part.type !== "image") return [];
    const media = block.part as { url: string; name?: string };
    const src = source(media.url);
    return src === undefined ? [] : [{ id: livePictureId(index), src, name: partName(media) }];
  });
}

/** Where a file the user sent is read from while its turn runs: the local preview, else the server's address. */
export const sentSource = (file: SentFile, source: MediaSource): string | undefined => file.preview ?? (file.url === undefined ? undefined : source(file.url));

/** The pictures among the files the live user message sent. */
export function sentPictures(files: readonly SentFile[], source: MediaSource): Picture[] {
  return files.flatMap((file, index) => {
    const src = file.image ? sentSource(file, source) : undefined;
    return src === undefined ? [] : [{ id: sentPictureId(index), src, name: file.name }];
  });
}

/** A picture drawn as a fixed-size thumbnail that opens the viewer; it takes the focus when pressed, so the viewer returns it. */
export function Thumbnail({ part, src, name, onOpen }: { part: "chat-image" | "chat-attachment-thumbnail"; src: string; name: string; onOpen: () => void }) {
  const open = (element: HTMLElement) => {
    element.focus();
    onOpen();
  };
  return (
    <img
      data-telo-part={part}
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      role="button"
      tabIndex={0}
      onClick={(event: MouseEvent<HTMLImageElement>) => open(event.currentTarget)}
      onKeyDown={(event: KeyboardEvent<HTMLImageElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open(event.currentTarget);
      }}
    />
  );
}

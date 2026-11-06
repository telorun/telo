import { useContext, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent } from "react";
import { useControl } from "../effective-controls.js";
import { MediaViewer } from "../media-viewer.js";
import { RendererContext } from "../renderer-context.js";
import { formatOwn, TextsContext, useSay } from "../texts.js";
import type { OwnText } from "../ui-error.js";
import { discard, type Drafts, type Pending } from "./chat-drafts.js";
import { Thumbnail, useChatMediaSource } from "./chat-pictures.js";
import { refusalOf, uploadFile } from "./chat-files.js";
import { ChatFailure, type ChatApi, type ChatSpec } from "./chat-protocol.js";

/** Opens the browser's file picker; the input it asks is never in the page. */
function pickFiles(accept: string, take: (files: File[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = accept;
  input.addEventListener("change", () => take([...(input.files ?? [])]), { once: true });
  input.click();
}

const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");

/**
 * The files attached to one draft of `drafts`: chosen, dropped or pasted, checked
 * against what the endpoint offers before they are uploaded, and removable.
 * Nothing is offered where the endpoint's spec offers no attachments.
 */
export function useAttachmentPicker({ api, drafts, owner, offer }: { api: ChatApi; drafts: Drafts; owner: string; offer: ChatSpec["attachments"] }) {
  const texts = useContext(TextsContext);
  const { lang } = useContext(RendererContext);
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const { files, problems } = drafts.get(owner);
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);

  /** A change to one file of the draft that started it, whichever conversation is shown by now. */
  const patch = (target: string, key: number, change: Partial<Pending>) =>
    drafts.patch(target, (draft) => ({ ...draft, files: draft.files.map((file) => (file.key === key ? { ...file, ...change } : file)) }));

  const add = (chosen: File[]) => {
    if (!offer) return;
    const target = owner;
    const refused: string[] = [];
    let held = drafts.get(target).files.filter((file) => file.status !== "failed").length;
    for (const file of chosen) {
      const why: OwnText | undefined = refusalOf(file, offer, held, lang);
      if (why) {
        refused.push(formatOwn(texts, why.key, why.values));
        continue;
      }
      held += 1;
      const key = ++counter.current;
      const image = file.type.startsWith("image/");
      // The item exists before the upload can report on it, a picture already drawn from the file itself.
      drafts.patch(target, (draft) => ({
        ...draft,
        files: [...draft.files, { key, name: file.name, image, ...(image ? { preview: window.URL.createObjectURL(file) } : {}), status: "uploading", percent: 0 }],
      }));
      const handle = uploadFile(api, file, formatOwn.bind(null, texts), (percent) => patch(target, key, { percent }));
      patch(target, key, { handle });
      handle.done.then(
        (attachment) => patch(target, key, { status: "done", percent: 100, attachment }),
        (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!(error instanceof ChatFailure)) throw error;
          patch(target, key, { status: "failed", reason: error.message });
        },
      );
    }
    drafts.patch(target, (draft) => ({ ...draft, problems: refused }));
  };

  const remove = (key: number) => {
    const gone = drafts.get(owner).files.find((file) => file.key === key);
    if (gone) discard(gone);
    drafts.patch(owner, (draft) => ({ ...draft, files: draft.files.filter((file) => file.key !== key) }));
  };

  const accept = offer ? [...new Set(offer.accepts.flatMap((each) => each.mediaTypes))].join(",") : "";

  const paste = (event: ClipboardEvent) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (!offer || pasted.length === 0) return;
    event.preventDefault();
    add(pasted);
  };

  const dropping = offer
    ? {
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          add([...event.dataTransfer.files]);
        },
      }
    : {};

  return {
    files,
    problems,
    uploading: files.some((file) => file.status === "uploading"),
    failed: files.some((file) => file.status === "failed"),
    ready: files.filter((file) => file.status === "done"),
    dragging,
    dropping,
    paste,
    remove,
    pick: () => pickFiles(accept, add),
  };
}

/** The files held, each with its progress or problem and the control that removes it; a picture shows as a thumbnail that opens the viewer over the pictures held. */
export function AttachmentChips({ files, onRemove }: { files: Pending[]; onRemove: (key: number) => void }) {
  const say = useSay();
  const Icon = useControl("Icon");
  const source = useChatMediaSource();
  const [viewing, setViewing] = useState<number>();
  const sourceOf = (file: Pending) => file.preview ?? (file.url ? source(file.url) : undefined);
  const pictures = useMemo(
    () => files.flatMap((file) => (file.image && sourceOf(file) !== undefined ? [{ key: file.key, src: sourceOf(file) as string, name: file.name }] : [])),
    [files],
  );
  const at = pictures.findIndex((picture) => picture.key === viewing);
  return (
    <>
      {viewing !== undefined && at >= 0 && (
        <MediaViewer items={pictures} index={at} onIndex={(next) => setViewing(pictures[next].key)} onClose={() => setViewing(undefined)} />
      )}
      <ul data-telo-part="chat-attachments" aria-label={say("chatAttachments")}>
        {files.map((file) => (
          <li key={file.key} data-telo-part="chat-attachment-item" data-status={file.status}>
            {file.image && sourceOf(file) !== undefined && <Thumbnail part="chat-attachment-thumbnail" src={sourceOf(file) as string} name={file.name} onOpen={() => setViewing(file.key)} />}
            <span data-telo-part="chat-attachment-name">{file.name}</span>
            {file.status === "uploading" && (
              <span data-telo-part="chat-attachment-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={file.percent} aria-label={say("chatAttachmentUploading", { name: file.name, percent: file.percent })}>
                {file.percent}%
              </span>
            )}
            {file.status === "failed" && (
              <span data-telo-part="chat-attachment-problem" role="alert">
                {say("chatAttachmentFailed", { name: file.name, reason: file.reason ?? "" })}
              </span>
            )}
            <button data-telo-part="chat-attachment-remove" type="button" aria-label={say("chatAttachmentRemove", { name: file.name })} onClick={() => onRemove(file.key)}>
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Why the files last chosen were refused. */
export function AttachmentRefusals({ problems }: { problems: string[] }) {
  return (
    <ul data-telo-part="chat-attachment-refusals" role="alert">
      {problems.map((problem, index) => (
        <li key={index} data-telo-part="chat-attachment-problem">
          {problem}
        </li>
      ))}
    </ul>
  );
}

/** Shown over what files can be dropped on. */
export function DropNotice() {
  const say = useSay();
  return (
    <div data-telo-part="chat-drop" role="status">
      {say("chatDropFiles")}
    </div>
  );
}

import { useEffect, useId, useState } from "react";
import { useControl } from "../effective-controls.js";
import { useSay } from "../texts.js";
import { AttachmentChips, AttachmentRefusals, DropNotice, useAttachmentPicker } from "./chat-attachment-picker.js";
import { attachmentId, entryAttachments, partName, type SentFile } from "./chat-blocks.js";
import { ChatButton } from "./chat-buttons.js";
import { Drafts, EMPTY_DRAFT, discard, sentFile } from "./chat-drafts.js";
import type { Attachment, ChatApi, ChatSpec, Entry } from "./chat-protocol.js";

const EDIT = "";

/** The files an entry carries, as held files already uploaded; negative keys keep clear of the picker's. */
function keptFiles(entry: Entry) {
  return entry.parts
    .filter((part) => ["image", "audio", "video", "file"].includes(part.type))
    .map((part, index) => {
      const media = part as { url: string; mediaType: string; name?: string; size?: number };
      const attachment: Attachment = { id: attachmentId(media.url), mediaType: media.mediaType, size: media.size ?? 0 };
      return { key: -(index + 1), name: partName(media), image: part.type === "image", url: media.url, status: "done" as const, percent: 100, attachment };
    });
}

/**
 * A user message being edited: its text and its files, kept, removed or added as
 * in the message box. Where the endpoint offers no attachments the files are not
 * shown and the message keeps the ones it has.
 */
export function EditForm({
  api,
  offer,
  entry,
  text,
  onCancel,
  onSubmit,
}: {
  api: ChatApi;
  offer: ChatSpec["attachments"];
  entry: Entry;
  text: string;
  onCancel: () => void;
  onSubmit: (message: string, attachments: string[], files: SentFile[]) => void;
}) {
  const say = useSay();
  const TextArea = useControl("TextArea");
  const id = useId();
  const [message, setMessage] = useState(text);
  const [drafts] = useState(() => {
    const own = new Drafts();
    if (offer) own.patch(EDIT, (draft) => ({ ...draft, files: keptFiles(entry) }));
    return own;
  });
  const { files, problems, uploading, failed, ready, dragging, dropping, paste, remove, pick } = useAttachmentPicker({ api, drafts, owner: EDIT, offer });

  useEffect(() => () => drafts.abortAll(), [drafts]);

  const sendable = !uploading && !failed && (message.trim() !== "" || (offer ? ready.length > 0 : entryAttachments(entry).length > 0));

  const submit = () => {
    if (!offer) return onSubmit(message.trim(), entryAttachments(entry), keptFiles(entry).map(sentFile));
    onSubmit(message.trim(), ready.map((file) => (file.attachment as Attachment).id), ready.map(sentFile));
    // The previews of the files sent belong to the message now; any other is released.
    for (const file of files) if (file.status !== "done") discard(file);
    drafts.patch(EDIT, () => EMPTY_DRAFT);
  };

  return (
    <div data-telo-part="chat-edit-form" onPaste={paste} {...dropping}>
      <TextArea id={id} label={say("chatEditMessage")} value={message} onChange={setMessage} invalid={false} required={false} disabled={false} />
      {files.length > 0 && <AttachmentChips files={files} onRemove={remove} />}
      {problems.length > 0 && <AttachmentRefusals problems={problems} />}
      {offer && <ChatButton which="attach" part="chat-attach" text={say("chatAttach")} onClick={pick} />}
      <button data-telo-part="cancel" type="button" onClick={onCancel}>
        {say("cancel")}
      </button>
      <button data-telo-part="submit" type="button" disabled={!sendable} onClick={submit}>
        {say("chatResend")}
      </button>
      {dragging && <DropNotice />}
    </div>
  );
}

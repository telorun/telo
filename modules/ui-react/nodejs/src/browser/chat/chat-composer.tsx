import { useEffect, useId, useSyncExternalStore, type KeyboardEvent } from "react";
import { useControl } from "../effective-controls.js";
import { useSay, useText, type WireText } from "../texts.js";
import { ChatButton } from "./chat-buttons.js";
import { AttachmentChips, AttachmentRefusals, DropNotice, useAttachmentPicker } from "./chat-attachment-picker.js";
import { EMPTY_DRAFT, NEW_DRAFT, discard, sentFile, type Drafts } from "./chat-drafts.js";
import type { SentFile } from "./chat-blocks.js";
import type { Attachment, ChatApi, ChatSpec } from "./chat-protocol.js";

/** A prompt offered on an empty conversation, and what choosing it does. */
export interface Starter {
  prompt: WireText;
  onChoose: "send" | "fill";
}

export interface ComposerProps {
  api: ChatApi;
  /** What is written, per conversation. */
  drafts: Drafts;
  /** The conversation shown; absent while it has no id. */
  conversation: string | undefined;
  spec: ChatSpec;
  placeholder: WireText | null;
  starters: Starter[];
  /** Whether a turn is being written. */
  running: boolean;
  /** Whether a reply is waited for, so the stop control stands where send does. */
  canStop: boolean;
  /** Whether the conversation has nothing in it, so starters are offered. */
  empty: boolean;
  /** Whether the buttons sit inside the message box's frame, or in a row under it. */
  actions: "inside" | "outside";
  onSend: (message: string, attachments: string[], files: SentFile[]) => void;
  onStop: () => void;
}

/**
 * The message box and what goes with it: the files attached, checked against
 * what the endpoint offers before they are uploaded, send — or stop while a
 * reply is written — and, on an empty conversation, the starters. Enter sends;
 * Shift+Enter breaks the line. An upload control exists only where the
 * endpoint's spec offers attachments.
 */
export function Composer({ api, drafts, conversation, spec, placeholder, starters, running, canStop, empty, actions, onSend, onStop }: ComposerProps) {
  const say = useSay();
  const text = useText();
  const TextArea = useControl("TextArea");
  const id = useId();
  const owner = conversation ?? NEW_DRAFT;
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const { message } = drafts.get(owner);
  const offer = spec.attachments;
  const { files, problems, uploading, ready, dragging, dropping, paste, remove, pick } = useAttachmentPicker({ api, drafts, owner, offer });

  useEffect(() => () => drafts.abortAll(), [drafts]);

  const setMessage = (value: string) => drafts.patch(owner, (draft) => ({ ...draft, message: value }));

  const sendable = !running && !uploading && (message.trim() !== "" || ready.length > 0);

  const choose = (starter: Starter) => {
    const prompt = text(starter.prompt);
    if (starter.onChoose === "send") return onSend(prompt, [], []);
    setMessage(prompt);
    // The control carries the id on its focusable element.
    const box = document.getElementById(id);
    box?.focus();
    if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) box.setSelectionRange(prompt.length, prompt.length);
  };

  const send = () => {
    if (!sendable) return;
    onSend(message.trim(), ready.map((file) => (file.attachment as Attachment).id), ready.map(sentFile));
    // The previews of the files sent belong to the message now; any other is released.
    for (const file of files) if (file.status !== "done") discard(file);
    drafts.patch(owner, () => EMPTY_DRAFT);
  };

  const keyDown = (event: KeyboardEvent) => {
    // The buttons may sit inside the box: Enter on one of them presses it.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const hint = `${id}-hint`;
  const placed = placeholder ? text(placeholder) : undefined;
  const row = (
    <div data-telo-part="chat-composer-actions">
      {offer && <ChatButton which="attach" part="chat-attach" text={say("chatAttach")} onClick={pick} />}
      {running && canStop ? (
        <ChatButton which="stop" part="chat-stop" text={say("chatStop")} onClick={onStop} />
      ) : (
        <ChatButton which="send" part="chat-send" text={say("chatSend")} type="submit" disabled={!sendable} />
      )}
    </div>
  );

  return (
    <form
      data-telo-part="chat-composer"
      data-actions={actions}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      {...dropping}
    >
      {empty && starters.length > 0 && (
        <div data-telo-part="chat-starters" role="group" aria-label={say("chatStarters")}>
          {starters.map((starter, index) => (
            <button key={index} data-telo-part="chat-starter" type="button" disabled={running} onClick={() => choose(starter)}>
              {text(starter.prompt)}
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && <AttachmentChips files={files} onRemove={remove} />}
      {problems.length > 0 && <AttachmentRefusals problems={problems} />}
      <div data-telo-part="chat-input" onKeyDown={keyDown} onPaste={paste}>
        {placed && message === "" && (
          <span data-telo-part="chat-placeholder" id={`${id}-placeholder`}>
            {placed}
          </span>
        )}
        <TextArea
          id={id}
          name="chatMessage"
          label={say("chatMessage")}
          describedBy={`${hint}${placed && message === "" ? ` ${id}-placeholder` : ""}`}
          value={message}
          onChange={setMessage}
          invalid={false}
          required={false}
          disabled={false}
        />
        {actions === "inside" && row}
      </div>
      <span data-telo-part="chat-hint" id={hint}>
        {say("chatComposerHint")}
      </span>
      {actions === "outside" && row}
      {dragging && <DropNotice />}
    </form>
  );
}

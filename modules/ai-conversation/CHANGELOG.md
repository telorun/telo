# Changelog

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* AiConversation.Create takes an optional caller-minted id; an id that already exists answers that conversation's header unchanged, so a retried create makes one conversation.
* New module: persistent branching chat transcripts for any AI agent. A conversation store abstract with operations to create, read, list, update and delete conversations, append messages under a parent (editing or regenerating keeps the old branch as a sibling), read a branch newest first by cursor with each row's place among its siblings, and record tool-call approvals once. A listing filters by a text in the title and by archived state (both kinds when it is left out) and runs newest first or oldest first. Appends are fenced by the conversation's current turn id.
* Uploaded files belong to one conversation. AiConversation.RegisterAttachment registers a file pending, or, given a binding of a conversation and its running turn, bound to that conversation at once and refused once another turn is current; a caller-supplied id that already exists answers its record only while it is unreleased and as the call would have left it. AiConversation.Admit admits a turn and binds the files its message names in one write conditional on the header version, Append binds the files an entry names, Delete releases the conversation's files in its own transaction, and ExpireAttachments and ForgetAttachments let an expiry pass release expired uploads and remove released files' records; ReadAttachment returns a file's record. A file that is unknown, expired, released or held by another conversation is ERR_CONVERSATION_ATTACHMENT_NOT_FOUND with data { attachment }, and the whole write is rolled back. Update now renames and archives only: a turn is admitted with Admit. The store contract gains admit, registerAttachment (with an optional binding), readAttachment, expireAttachments and forgetAttachments, and append takes attachments.

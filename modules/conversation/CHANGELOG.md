# Changelog

## 0.3.0 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.2.0 - 2026-11-06
### Added
* An attachment belongs to one conversation: POST /attachments answers { id, mediaType, size } and the upload is pending, with no address, until the first admitted turn naming it binds it to that turn's conversation; a turn naming one that is unknown, expired, deleted or another conversation's is refused at /body/attachments/<i>, and TurnRequest.attachments holds each id once. A bound file is read at GET /conversations/<id>/attachments/<attachment id> and nowhere else, its url the relative reference conversations/<id>/attachments/<attachment id>; any other read is a 404 ERR_CONVERSATION_ATTACHMENT_NOT_FOUND. The Attachment shape loses url.
* New module: the conversation contract every chat server and client speaks — the Conversation.Spec, Conversation.Event and Conversation.Entry shapes, the route body shapes, and the Conversation.Conversation abstract a chat endpoint extends. A conversation is a forest (a turn's parent may be null for a new root), every entry carries its turn, its place among its siblings and its tool calls' approvals, entries page newest first and are read through a chosen entry, and a conversation summary says whether its latest turn is still running so a client can reopen it. The spec lists only the operations branch and cancel; Conversation.conversations is the DataModel.Collection over ConversationSummary (filters title contains and archived eq, sort updatedAt) that GET /conversations speaks, so a page lists conversations with a Ui.Listing over a Ui.CollectionSource.

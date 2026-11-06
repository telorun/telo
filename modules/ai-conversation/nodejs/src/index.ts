// For a backend: the store contract the operations call, its coded errors and
// the id minting. Importing any of it is optional — a store is recognised by
// its methods.
export type {
  AdmitRequest,
  AppendRequest,
  ApprovalDecision,
  ApprovalRecord,
  AttachmentBinding,
  AttachmentRecord,
  ConversationHeader,
  ConversationStore,
  CreateRequest,
  EntriesRequest,
  EntryRow,
  ExpireAttachmentsRequest,
  ListRequest,
  Page,
  RecordApprovalRequest,
  RegisterAttachmentRequest,
  Siblings,
  StoredEntry,
  UpdateRequest,
} from "./conversation-store-contract.js";
export { isConversationStore } from "./conversation-store-contract.js";
export * from "./conversation-errors.js";
export { mintAttachmentId, mintConversationId, mintEntryId } from "./conversation-id.js";

// Controller entry points, selected by each kind's PURL fragment.
export {
  Create,
  Read,
  List,
  Entries,
  Append,
  Update,
  Admit,
  Delete,
  RecordApproval,
  RegisterAttachment,
  ReadAttachment,
  ExpireAttachments,
  ForgetAttachments,
} from "./operations.js";

import { InvokeError } from "@telorun/sdk";

export interface SqlNames {
  readonly schema: string;
  readonly conversations: string;
  readonly entries: string;
  readonly approvals: string;
  readonly attachments: string;
  /** Unquoted names of the indexes, for DDL. */
  readonly entriesSequenceIndex: string;
  readonly entriesBranchIndex: string;
  readonly approvalsCallIndex: string;
  readonly conversationsRecentIndex: string;
  readonly conversationsUpdatedIndex: string;
  readonly attachmentsHolderIndex: string;
  readonly attachmentsReleasedIndex: string;
}

/** A table prefix reaches SQL as part of an identifier, so it is held to a plain identifier. */
export function validatePrefix(prefix: string, describe: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
    throw new InvokeError(
      "ERR_INVALID_VALUE",
      `${describe}: 'tablePrefix' must be a plain identifier (letters, digits, underscore; not starting with a digit). Got "${prefix}".`,
    );
  }
  return prefix;
}

export function namesOf(prefix: string, quote: (name: string) => string): SqlNames & { raw: Record<string, string> } {
  const raw = {
    schema: `${prefix}schema`,
    conversations: `${prefix}conversations`,
    entries: `${prefix}entries`,
    approvals: `${prefix}approvals`,
    attachments: `${prefix}attachments`,
  };
  return {
    schema: quote(raw.schema),
    conversations: quote(raw.conversations),
    entries: quote(raw.entries),
    approvals: quote(raw.approvals),
    attachments: quote(raw.attachments),
    entriesSequenceIndex: quote(`${prefix}entries_sequence`),
    entriesBranchIndex: quote(`${prefix}entries_branch`),
    approvalsCallIndex: quote(`${prefix}approvals_call`),
    conversationsRecentIndex: quote(`${prefix}conversations_recent`),
    conversationsUpdatedIndex: quote(`${prefix}conversations_updated`),
    attachmentsHolderIndex: quote(`${prefix}attachments_holder`),
    attachmentsReleasedIndex: quote(`${prefix}attachments_released`),
    raw,
  };
}

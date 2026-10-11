import { FileText, RotateCw, TriangleAlert, X } from "lucide-react";
import { formatBytes, isImageType, type ComposerAttachment } from "@/agent";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ai-elements/loader";
import { cn } from "@/lib/utils";
import { AttachmentThumbnail } from "./MessageAttachments";

/**
 * The files on the composer, one chip each: name, size, an image's thumbnail,
 * whether it is still uploading, and why it failed when it did. Remove drops
 * the file from the message only — the agent keeps what was uploaded.
 */
export function ComposerAttachments({
  attachments,
  fileOf,
  onRemove,
  onRetry,
}: {
  attachments: ComposerAttachment[];
  /** The local file behind a chip added in this session. */
  fileOf: (key: string) => File | undefined;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attached files" className="mb-2 flex flex-col gap-1">
      {attachments.map((attachment) => {
        const file = fileOf(attachment.key);
        const image = isImageType(attachment.mediaType);
        return (
          <li
            key={attachment.key}
            className={cn(
              "flex items-center gap-2 rounded-md border border-border bg-muted/40 p-1.5 text-xs",
              attachment.state === "failed" && "border-destructive/40 bg-destructive/10",
            )}
          >
            {image && attachment.state === "uploaded" ? (
              <AttachmentThumbnail attachment={attachment} file={file} className="size-9" />
            ) : image && file ? (
              <AttachmentThumbnail attachment={{ ...attachment, id: attachment.key }} file={file} className="size-9" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate">{attachment.name}</div>
              <div className={cn("text-muted-foreground", attachment.state === "failed" && "text-destructive")}>
                {attachment.state === "failed" ? (
                  <span className="flex items-start gap-1">
                    <TriangleAlert className="mt-px size-3 shrink-0" />
                    <span>{attachment.reason}</span>
                  </span>
                ) : attachment.state === "uploading" ? (
                  <span className="flex items-center gap-1">
                    <Loader size={12} />
                    Uploading… {formatBytes(attachment.size)}
                  </span>
                ) : (
                  formatBytes(attachment.size)
                )}
              </div>
            </div>
            {attachment.state === "failed" && file && (
              <Button variant="ghost" size="icon-xs" onClick={() => onRetry(attachment.key)} aria-label={`Retry ${attachment.name}`} title="Retry">
                <RotateCw />
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" onClick={() => onRemove(attachment.key)} aria-label={`Remove ${attachment.name}`} title="Remove from the message">
              <X />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

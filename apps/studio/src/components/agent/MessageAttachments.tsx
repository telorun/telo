import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Download, FileText, ImageOff } from "lucide-react";
import { toast } from "sonner";
import { formatBytes, isImageType, type Attachment } from "@/agent";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Reads an attachment's bytes from the agent, typed as its record says. Null
 *  where there is no agent to read from: the files are then named, not shown. */
export const AttachmentLoaderContext = createContext<((attachment: Attachment) => Promise<Blob>) | null>(null);

/** An object URL for `blob`, revoked when the blob changes or the user leaves. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** True once the element has come into view — at once where the browser cannot say. */
function useSeen(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const target = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = target.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return [target, seen];
}

function describe(attachment: Attachment): string {
  return `${attachment.name} · ${formatBytes(attachment.size)}`;
}

const CHIP = "flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-xs";

/**
 * An image attachment: a thumbnail that opens the image larger. `file` is the
 * local file of a chip added in this session; without it the bytes are read
 * from the agent once the thumbnail is in view. A read that fails leaves a
 * chip naming the file and why.
 */
export function AttachmentThumbnail({
  attachment,
  file,
  className,
}: {
  attachment: Attachment;
  file?: Blob;
  className?: string;
}) {
  const load = useContext(AttachmentLoaderContext);
  const [target, seen] = useSeen();
  const [read, setRead] = useState<{ blob: Blob } | { failed: string } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (file || !load || !seen) return;
    let cancelled = false;
    load(attachment).then(
      (blob) => !cancelled && setRead({ blob }),
      (err: unknown) => !cancelled && setRead({ failed: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [attachment, file, load, seen]);
  const url = useObjectUrl(file ?? (read && "blob" in read ? read.blob : null));

  if (!file && (!load || (read && "failed" in read))) {
    return (
      <span className={CHIP} title={read && "failed" in read ? `Could not be loaded: ${read.failed}` : undefined}>
        <ImageOff className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{describe(attachment)}</span>
      </span>
    );
  }
  return (
    <div ref={target} className={cn("size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted", className)}>
      {url && (
        <button type="button" className="size-full" onClick={() => setOpen(true)} aria-label={`Open ${attachment.name}`}>
          <img src={url} alt={attachment.name} className="size-full object-cover" />
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="truncate pr-8">{attachment.name}</DialogTitle>
          <DialogDescription>{formatBytes(attachment.size)}</DialogDescription>
          {url && <img src={url} alt={attachment.name} className="max-h-[75vh] w-full object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoked once the browser has taken the download, not under it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Any other attachment: its name and size, downloading it under its name. */
function AttachmentFileChip({ attachment }: { attachment: Attachment }) {
  const load = useContext(AttachmentLoaderContext);
  if (!load) {
    return (
      <span className={CHIP}>
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{describe(attachment)}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(CHIP, "hover:bg-muted")}
      title={`Download ${attachment.name}`}
      onClick={() =>
        load(attachment).then(
          (blob) => download(blob, attachment.name),
          (err: unknown) =>
            toast.error(`Failed to download ${attachment.name}: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{describe(attachment)}</span>
      <Download className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The files a user message carried, from its record. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="max-w-full">
          {isImageType(attachment.mediaType) ? (
            <AttachmentThumbnail attachment={attachment} />
          ) : (
            <AttachmentFileChip attachment={attachment} />
          )}
        </li>
      ))}
    </ul>
  );
}

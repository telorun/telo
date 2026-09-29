import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ChevronsUpDown, Download, Ellipsis, Pencil, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CONVERSATION_POLL_MS, useAgent, type Conversation, type ConversationDownload } from "@/agent";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/** How long the filter waits for typing to settle before it asks the agent. */
const FILTER_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;
/** The largest page the agent serves: a refresh re-reads what is shown in one. */
const MAX_PAGE = 200;

function titleOf(conversation: Pick<Conversation, "title">): string {
  return conversation.title ?? "Untitled";
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(0, "minute");
}

function tokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k tokens` : `${count} tokens`;
}

function download({ filename, content, type }: ConversationDownload) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function failure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A delete waiting for its confirmation; `running` once the agent said the
 *  conversation's latest turn is running, which the confirmation then names. */
interface PendingDelete {
  conversation: Conversation;
  running: boolean;
}

/**
 * The panel's title, and the list of this agent's conversations behind it:
 * filtered by the agent's own search, archived ones on request, and each
 * renamable, archivable, exportable and deletable from its menu.
 */
export function ConversationSwitcher() {
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<Conversation[]>([]);
  const [next, setNext] = useState<{ before: string; beforeId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // Focused once the menu that asked for it has closed: a menu keeps the focus
  // inside itself while open, which would blur — and so commit — the input.
  const renameInput = useRef<HTMLInputElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const shown = useRef(0);
  shown.current = items.length;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(filter.trim().slice(0, 200)), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter]);

  // The first page again, as long as what is shown: the list re-read in place.
  const { listConversations } = agent;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const page = await listConversations({
        archived,
        q: query || undefined,
        limit: Math.min(MAX_PAGE, Math.max(PAGE_SIZE, shown.current)),
      });
      if (gen !== generation.current) return;
      setItems(page.conversations);
      setNext(page.next);
      setListError(null);
    } catch (err) {
      if (gen === generation.current) setListError(failure(err));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [archived, listConversations, query]);

  useEffect(() => {
    if (!open) return;
    shown.current = 0;
    void refresh();
    const timer = setInterval(() => void refresh(), CONVERSATION_POLL_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const loadMore = async () => {
    if (!next) return;
    const gen = generation.current;
    setLoading(true);
    try {
      const page = await listConversations({ archived, q: query || undefined, limit: PAGE_SIZE, cursor: next });
      if (gen !== generation.current) return;
      setItems((prev) => [...prev, ...page.conversations.filter((c) => !prev.some((p) => p.id === c.id))]);
      setNext(page.next);
    } catch (err) {
      setListError(failure(err));
    } finally {
      setLoading(false);
    }
  };

  const act = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
      await refresh();
    } catch (err) {
      setListError(`${what} failed: ${failure(err)}`);
    }
  };

  const commitRename = () => {
    const target = renaming;
    if (!target) return;
    const title = target.title.trim();
    setRenaming(null);
    if (!title) return;
    void act("Rename", () => agent.renameConversation(target.id, title));
  };

  const exportAs = (conversation: Conversation, format: "markdown" | "json") =>
    agent.exportConversation(conversation.id, format).then(download, (err: unknown) => {
      toast.error(`Export failed: ${failure(err)}`);
    });

  const requestDelete = (conversation: Conversation) =>
    setPendingDelete({
      conversation,
      running: conversation.id === agent.conversationId && agent.locked,
    });

  const confirmDelete = async () => {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(null);
    try {
      const outcome = await agent.deleteConversation(pending.conversation.id, pending.running);
      if (outcome === "running") {
        setPendingDelete({ conversation: pending.conversation, running: true });
        return;
      }
      await refresh();
    } catch (err) {
      const said = `Delete failed: ${failure(err)}`;
      setListError(said);
      toast.error(said);
    }
  };

  const current = agent.conversation;
  const heading = current ? titleOf(current) : "New conversation";
  const switching = agent.status === "launching" || agent.status === "seeding";
  const now = Date.now();

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-between gap-1 px-1.5" title={heading}>
            <span className="truncate text-sm font-medium">{heading}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 gap-2 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="pl-7"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={archived} onCheckedChange={(checked) => setArchived(checked === true)} />
            Show archived
          </label>
          {listError && <p className="text-xs text-destructive">{listError}</p>}
          <ul className="max-h-80 overflow-y-auto" aria-label="Conversations">
            {items.length === 0 && !loading && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                {query ? "No conversation matches." : archived ? "No archived conversations." : "No conversations yet."}
              </li>
            )}
            {items.map((conversation) => (
              <li
                key={conversation.id}
                className={cn(
                  "group/item flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted",
                  conversation.id === agent.conversationId && "bg-muted",
                )}
              >
                {renaming?.id === conversation.id ? (
                  <Input
                    ref={renameInput}
                    value={renaming.title}
                    aria-label="Conversation title"
                    maxLength={200}
                    onChange={(e) => setRenaming({ id: conversation.id, title: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="h-7"
                  />
                ) : (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start text-left disabled:opacity-50"
                    disabled={switching}
                    onClick={() => {
                      agent.openConversation(conversation);
                      setOpen(false);
                    }}
                  >
                    <span className="w-full truncate text-sm">{titleOf(conversation)}</span>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(conversation.updatedAt, now)} · {tokens(conversation.totalTokens)}
                    </span>
                  </button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${titleOf(conversation)}`}>
                      <Ellipsis className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-48"
                    onCloseAutoFocus={(e) => {
                      if (!renameInput.current) return;
                      e.preventDefault();
                      renameInput.current.focus();
                    }}
                  >
                    <DropdownMenuItem
                      onSelect={() => setRenaming({ id: conversation.id, title: conversation.title ?? "" })}
                    >
                      <Pencil />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void act(conversation.archived ? "Unarchive" : "Archive", () =>
                          agent.setConversationArchived(conversation.id, !conversation.archived),
                        )
                      }
                    >
                      {conversation.archived ? <ArchiveRestore /> : <Archive />}
                      {conversation.archived ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void exportAs(conversation, "markdown")}>
                      <Download />
                      Export as Markdown
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void exportAs(conversation, "json")}>
                      <Download />
                      Export as JSON
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => requestDelete(conversation)}>
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
          {next && (
            <Button variant="outline" size="xs" onClick={() => void loadMore()} disabled={loading}>
              Load more
            </Button>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(isOpen) => !isOpen && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete ? titleOf(pendingDelete.conversation) : ""}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.running && "Its running turn will be stopped first. "}
              The conversation and its history are deleted from the agent. Your workspace files are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

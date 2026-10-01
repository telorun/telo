import { MessageSquarePlus } from "lucide-react";
import * as React from "react";

import { reviewApi, type Revision } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuthor } from "@/lib/author-name";

const WHOLE_PLAN = "__plan";

/** A comment on the revision, or on one of its stored items. */
export function CommentPanel({
  planId,
  revision,
  item,
  onItemChange,
  onCommented,
  textareaRef,
}: {
  planId: string;
  revision: Revision;
  item: string | undefined;
  onItemChange: (item: string | undefined) => void;
  onCommented: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const author = useAuthor();
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(undefined);

  const submit = async () => {
    if (!author) return;
    setBusy(true);
    setError(undefined);
    try {
      await reviewApi.comment(planId, {
        author,
        body,
        revision: revision.seq,
        ...(item === undefined ? {} : { item }),
      });
      setBody("");
      onCommented();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comment on revision {revision.seq}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="comment-item">On</Label>
          <Select
            value={item ?? WHOLE_PLAN}
            onValueChange={(next) => onItemChange(next === WHOLE_PLAN ? undefined : next)}
          >
            <SelectTrigger id="comment-item" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WHOLE_PLAN}>The whole plan</SelectItem>
              {revision.items.map((id) => (
                <SelectItem key={id} value={id}>
                  Item {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="comment-body">Comment</Label>
          <Textarea
            id="comment-body"
            ref={textareaRef}
            value={body}
            maxLength={20000}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <Button disabled={busy || !author || body.trim() === ""} onClick={submit} className="self-start">
          <MessageSquarePlus />
          Comment
        </Button>
        {!author && <p className="text-xs text-muted-foreground">Enter your name at the top to comment.</p>}
        {error !== undefined && <ErrorNotice error={error} />}
      </CardContent>
    </Card>
  );
}

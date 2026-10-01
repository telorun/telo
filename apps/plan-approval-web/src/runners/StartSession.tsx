import { Play } from "lucide-react";
import * as React from "react";

import { reviewApi } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuthor } from "@/lib/author-name";

/** Queues a start: the runner starts a Claude session in a repository it serves.
 *  The session's name is minted by the server; its ID arrives with the outcome. */
export function StartSession({ runner, repos, onQueued }: { runner: string; repos: string[]; onQueued: () => void }) {
  const author = useAuthor();
  const [repo, setRepo] = React.useState(repos[0] ?? "");
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [queued, setQueued] = React.useState<number | undefined>(undefined);
  const [error, setError] = React.useState<unknown>(undefined);

  const start = async () => {
    if (!author) return;
    setBusy(true);
    setError(undefined);
    setQueued(undefined);
    try {
      const { seq } = await reviewApi.startSession(runner, { author, repo, prompt });
      setQueued(seq);
      setPrompt("");
      onQueued();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a session</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="start-repo">Repository</Label>
          <Select value={repo} onValueChange={setRepo}>
            <SelectTrigger id="start-repo" className="w-full">
              <SelectValue placeholder="This runner serves no repository" />
            </SelectTrigger>
            <SelectContent>
              {repos.map((slug) => (
                <SelectItem key={slug} value={slug}>
                  {slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="start-prompt">Prompt</Label>
          <Textarea id="start-prompt" value={prompt} maxLength={8000} onChange={(e) => setPrompt(e.target.value)} />
        </div>
        <Button className="self-start" disabled={busy || !author || repo === "" || prompt.trim() === ""} onClick={start}>
          <Play />
          Start
        </Button>
        {!author && <p className="text-xs text-muted-foreground">Enter your name at the top to start a session.</p>}
        {queued !== undefined && <p className="text-sm">Queued as command #{queued}.</p>}
        {error !== undefined && <ErrorNotice error={error} />}
      </CardContent>
    </Card>
  );
}

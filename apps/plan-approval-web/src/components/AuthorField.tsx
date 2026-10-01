import { UserRound } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useAuthorName } from "@/lib/author-name";

/** The self-declared reviewer name every write carries, remembered in the browser. */
export function AuthorField() {
  const [author, setAuthor] = useAuthorName();
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <UserRound className="size-4" />
      <span className="sr-only">Your name</span>
      <Input
        className="h-8 w-44"
        placeholder="Your name"
        value={author}
        maxLength={100}
        onChange={(event) => setAuthor(event.target.value)}
      />
    </label>
  );
}

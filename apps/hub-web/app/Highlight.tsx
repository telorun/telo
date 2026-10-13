/** Words shorter than this match everywhere and highlight nothing useful. */
const MIN_WORD = 2;

/** `text` with each word of `query` marked where it occurs. Search also matches
 *  on meaning, so a hit may hold none of the words — then this is plain text. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query
    .split(/\s+/)
    .filter((word) => word.length >= MIN_WORD)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary/15 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

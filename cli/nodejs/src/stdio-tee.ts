export type StdioLineHandler = (stream: "stdout" | "stderr", line: string) => void;

/**
 * Tee `process.stdout` / `process.stderr`: every write still reaches the real
 * stream (the terminal is untouched), and each *completed* line is also handed to
 * `onLine`. Output is line-buffered — a partial write is held until its newline —
 * and a trailing partial line is flushed on restore so nothing is dropped.
 *
 * Entirely contained in this process: the returned function reinstates the
 * original `write`s, leaving no trace of the wrapping behind.
 */
export function teeStdio(onLine: StdioLineHandler): () => void {
  const restores: Array<() => void> = [];

  const wrap = (stream: NodeJS.WriteStream, name: "stdout" | "stderr"): void => {
    const original = stream.write.bind(stream) as typeof stream.write;
    // One decoder per stream so a multi-byte char split across writes is rejoined.
    const decoder = new TextDecoder();
    let pending = "";

    const emit = (text: string): void => {
      pending += text;
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        onLine(name, pending.slice(0, idx).replace(/\r$/, ""));
        pending = pending.slice(idx + 1);
      }
    };

    // Pass every arg through verbatim so all write() overloads keep working
    // (string+encoding, buffer+callback, …); only observe the chunk's text.
    const tee = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? decoder.decode(chunk, { stream: true })
            : "";
      if (text) emit(text);
      return (original as (...args: unknown[]) => boolean)(chunk, encoding, cb);
    }) as typeof stream.write;

    stream.write = tee;
    restores.push(() => {
      stream.write = original;
      if (pending.length > 0) {
        onLine(name, pending);
        pending = "";
      }
    });
  };

  wrap(process.stdout, "stdout");
  wrap(process.stderr, "stderr");

  return () => {
    for (const restore of restores) restore();
  };
}

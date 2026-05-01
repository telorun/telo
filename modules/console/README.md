---
description: "Console I/O: Console.WriteLine writes output lines, Console.ReadLine reads stdin with prompt for interactive CLI applications, Console.WriteStream drains a stream of strings or bytes to stdout"
---

# Console

Direct access to the process's standard streams. Useful for CLI-style manifests, interactive demos, and tests that want to print without a logger layer.

`WriteLine` and `ReadLine` are `Telo.Runnable` — they execute once when their position in a `Run.Sequence` (or as an Application `target`) is reached. `WriteStream` is `Telo.Invocable` — it drains a stream provided as `input`.

---

## Console.WriteLine

Writes `output` to stdout followed by a newline.

```yaml
kind: Console.WriteLine
metadata:
  name: Greet
output: "Hello, ${{ inputs.name }}!"
```

`output` supports `${{ }}` templating like any other runtime field — variables, secrets, resource snapshots, and (inside a `Run.Sequence`) `steps.<name>.result` are all in scope.

---

## Console.ReadLine

Reads a single line from stdin. The prompt is printed without a trailing newline so the caret stays on the same line.

```yaml
kind: Console.ReadLine
metadata:
  name: AskName
prompt: "What's your name? "
```

The captured value surfaces via the standard runnable result, so wrapping `Console.ReadLine` in a `Run.Sequence` step is the usual way to feed it downstream:

```yaml
kind: Run.Sequence
metadata:
  name: Greeter
steps:
  - name: ask
    invoke:
      kind: Console.ReadLine
    inputs:
      prompt: "Name: "
  - name: greet
    invoke:
      kind: Console.WriteLine
    inputs:
      output: "Hello, ${{ steps.ask.result }}!"
```

---

## Console.WriteStream

Drains a `Stream<string | Uint8Array>` to stdout. Strings go through Node's native UTF-8 path; `Uint8Array` chunks pass through unchanged. No newline policy — producers control framing.

```yaml
kind: Console.WriteStream
metadata:
  name: Stdout
```

Inside a `Run.Sequence`, wire an upstream stream to the resource's `input`:

```yaml
- name: Print
  invoke: { kind: Console.WriteStream, name: Stdout }
  inputs:
    input: "${{ steps.SomeProducer.result.output }}"
```

`WriteStream` pairs naturally with text producers like `RecordStream.ExtractText` (`Stream<string>`) and with byte-producing codecs like `Ndjson.Encoder` / `Sse.Encoder` / `Octet.Encoder` (`Stream<Uint8Array>`) — both shapes are accepted on the same input contract.

---

## Notes

- Intended for the root Application process. When a kernel runs inside a non-interactive environment (a detached container, a Temporal worker), `Console.ReadLine` will block indefinitely — wrap it with an outer sequence that only runs in interactive contexts.
- Output is unbuffered line-by-line. Each `Console.WriteLine` call is a single `stdout.write`. `Console.WriteStream` writes one chunk per iteration — chunk boundaries are upstream-defined.

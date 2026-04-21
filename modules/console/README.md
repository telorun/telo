# Console

Direct access to the process's standard streams. Useful for CLI-style manifests, interactive demos, and tests that want to print without a logger layer.

Both kinds are `Telo.Runnable` — they execute once when their position in a `Run.Sequence` (or as an Application `target`) is reached.

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

## Notes

- Intended for the root Application process. When a kernel runs inside a non-interactive environment (a detached container, a Temporal worker), `Console.ReadLine` will block indefinitely — wrap it with an outer sequence that only runs in interactive contexts.
- Output is unbuffered line-by-line. Each `Console.WriteLine` call is a single `stdout.write`.

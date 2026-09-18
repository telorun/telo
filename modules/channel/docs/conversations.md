# Holding a conversation

A channel is a running program you can read from and write to as text. Three operations act on one, each an ordinary invocable resource that names the channel:

| Kind | Inputs | Result |
| --- | --- | --- |
| `Channel.ReadUntil` | `until` — literal text to read up to | `text` — everything read, up to and including it |
| `Channel.SendLine` | `text` — the line, without its newline | — |
| `Channel.End` | — | — |

`Channel.ReadUntil` also declares `timeout` on the resource (default `30s`), so every read is bounded.

## Reading consumes

A read returns everything up to and including the first occurrence of `until`, and leaves the rest for the next read. That is what makes a sequence of reads a conversation rather than the same text over and over: leaving the marker in place would match it again forever.

Reading a line is `until: "\n"`. There is no separate line mode, and `until` is never a pattern — matching beyond a literal belongs in CEL over the text a read returns, where the expression language is the same one every other field uses.

## Branching on what came back

There is no dialogue script, on purpose: a script cannot answer differently depending on what it just read. The step grammar already has the control flow, so a conversation is steps:

```yaml
kind: Run.Loop
metadata: { name: conversation }
maxIterations: 4
steps:
  - name: prompt
    invoke: !ref read
    inputs: { until: "> " }
  - name: reply
    invoke: !ref send
    inputs:
      text: !cel >-
        contains(steps.prompt.result.text, 'name?') ? 'Ada' : '/exit'
```

## When it goes wrong

| Code | Means |
| --- | --- |
| `ERR_CHANNEL_READ_TIMEOUT` | The marker did not arrive in time. Carries the text read while waiting — usually the prompt the program is actually sitting on. |
| `ERR_CHANNEL_CLOSED` | The program exited, or its input was closed, before the operation could finish. Carries what had been read and which side closed. |
| `ERR_CHANNEL_OVERFLOW` | A channel retains a bounded amount of unread output and the marker is further away than that. Waiting longer cannot help. |

Each is catchable by code in a `try:` / `catch:` step, so a test can assert on a conversation that is *supposed* to stall.

## What is retained, and when

A channel retains output only while something reads it: a reader opens the channel's output when the reader resource is created, and a channel no reader names retains nothing. That is what keeps supervising a long-running program free — a server child under `App.Instance` streams its log to the parent and buffers none of it.

**One reader per channel.** Two would take each other's text, and which one saw a given line would depend on scheduling. Declare one `Channel.ReadUntil` and invoke it from every step that reads.

Retention is bounded. With nothing waiting to read, a full buffer stops taking the program's output and the program blocks — the same back-pressure as `cmd | head`. With a read waiting, a full buffer means the marker is further away than the channel holds, and the read fails rather than dropping what it has.

## Closing the input

`Channel.End` closes the input side. A program waiting for a line reads end of input instead, and can finish on its own — so its exit code is the one it chose, not one a shutdown imposed. It is idempotent: a caller that has said "no more input" need not remember whether it already said it.

## Which output is conversational

`Channel.Text` has one output side, and for a child application that is its stdout. Its stderr keeps flowing to the parent as the diagnostic stream and is never matched against: a Telo application writes structured log records there, and a merged channel would let `until` match inside a JSON log line. A program that prompts on stderr cannot be conversed with — a deliberate loss.

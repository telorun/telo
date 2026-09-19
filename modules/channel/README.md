# Channel

Hold a conversation with a running program over a text channel: read what it printed up to a marker, answer it, read the next thing, close its input when the exchange is over.

## Why use this

- **The next answer can depend on the last thing you read.** A fixed script handed over at start-up cannot answer a question that only appears after the previous one is answered; reading and writing as separate steps can.
- **Nothing hangs.** Every read is bounded, and a read that does not find its marker fails with the text that arrived instead — so a stuck exchange says what the program was actually printing.
- **One vocabulary for anything text-shaped.** A child application implements `Channel.Text` today; a shell session or a remote host implements the same contract, and the steps written against it do not change.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Channel.Text` | What something on the other end of a text conversation is. Abstract — `App.Instance` extends it. |
| `Channel.SendLine` | Write one line to the program. |
| `Channel.ReadUntil` | Read up to a literal marker, or fail saying what came instead. |
| `Channel.End` | Close the input side, so the program reads end of input and can finish. |

## Example

```yaml
kind: Channel.ReadUntil
metadata: { name: read }
channel: !ref app
timeout: "10s"
---
kind: Channel.SendLine
metadata: { name: send }
channel: !ref app
---
kind: Run.Sequence
metadata: { name: test }
steps:
  - name: prompt
    invoke: !ref read
    inputs: { until: "Username: " }
  - name: answer
    invoke: !ref send
    inputs: { text: Ada }
```

Branching is the ordinary step grammar — `if`, `while`, `switch` and CEL over `steps.<name>.result.text`.

## Reference

- [Holding a conversation](docs/conversations.md)

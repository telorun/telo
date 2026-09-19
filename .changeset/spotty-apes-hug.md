---
"@telorun/kernel": minor
"@telorun/sdk": minor
---

`ctx.runtime.run` takes a child's declared inputs by name, and a child is now reachable as a text channel.

`RuntimeRunOptions.inputs` carries values for the child manifest's `variables:` / `secrets:` / `ports:` under the names the child declares, rather than the environment variables it binds them to. The child validates each value against its own declaration, and a name it does not declare is refused with the names it does declare in the message — previously a caller could only hand over an environment map, which nothing could check and which let a caller set keys the child never declared.

`RuntimeRun` also gains `stdin` — a `TextChannelInput` with `write(text)` and `end()` — and `started`, which settles once the child's own `targets:` have been dispatched (so a server it declares is listening) or as soon as it exits. Input is a handle written to over time rather than a value handed over at the start, because the useful case is a conversation: answer the prompt the child just printed, read what it says next, answer that. `started` is separate from `run()` returning because an interactive child blocks on its first prompt and never finishes dispatching its targets, so a caller holding a conversation must not wait for it.

The SDK exports the two shapes a channel implementation composes: `TextChannel` (`openOutput()` plus `input`) and `TextChannelInput`. `cancel()` now ends the child's input before cancelling, so a child parked on a read wakes rather than being killed mid-wait.

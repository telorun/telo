# Ui.ConversationSource

A conversation endpoint as the browser reaches it: the
[conversation](../../conversation/README.md) — what the endpoint offers before
any message — and where its routes are served.

| Field | | |
| --- | --- | --- |
| `conversation` | required | a `Conversation.Conversation` — a kind extending it — `!ref` or inline |
| `basePath` | required | [app-relative](nodes.md#addresses) URL the conversation's routes are served under |

```yaml
kind: Ui.ConversationSource
metadata: { name: assistantSource }
conversation: !ref assistant
basePath: /api/chat
```

Whatever serves `basePath` speaks
[the conversation contract](../../conversation/docs/conversation-contract.md):
`<basePath>/turns`, `<basePath>/conversations`, `<basePath>/attachments`, and
the rest. One source written once is what every [`Ui.Chat`](chat.md) over the
endpoint names, so the page and the endpoint cannot be given different ones.

## What the source reads

The conversation is read for its published `Conversation.Spec`: the
`attachments` it accepts (each kind of file with its media types and size
limit, and how many a message may carry) when it takes any, and the
`operations` it supports (`branch`, `cancel`). A conversation that publishes no `operations` is refused
when the source starts (`ERR_REF_UNRESOLVED`).

`ui` imports the `conversation` module and nothing that implements it, so a
screen over a conversation depends on the contract alone — never on the agent
behind it.

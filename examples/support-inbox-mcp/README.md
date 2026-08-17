# Support inbox — one app, a REST API and an MCP server

Two front doors onto the same two handlers:

```
Http.Server (:8066)
├── /api → Http.Api          ─┐
└── /mcp → Mcp.HttpEndpoint  ─┴─► searchTickets (Sql.Query)
                                  closeTicket   (Run.Sequence → Sql.Command)
```

`searchTickets` and `closeTicket` are declared once. The HTTP route describes
them for a browser (`request.query` → SQL bindings → JSON body); the MCP tool
entry describes them for a model (`argumentsSchema` → `inputs:` → a rendered
`content` block). Neither surface is a wrapper around the other, and there is no
second process to deploy or keep in step.

## Run it

```sh
telo ./examples/support-inbox-mcp

curl -s 'localhost:8066/api/tickets?q=login'
```

## Talk to it as an MCP client

```sh
curl -s -XPOST localhost:8066/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s -XPOST localhost:8066/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"search_tickets","arguments":{"query":"login"}}}'
```

Any MCP client works — point Claude Desktop, Cursor, or your own agent at
`http://localhost:8066/mcp`. The `instructions:` block on `Mcp.HttpEndpoint` is
handed to the client on `initialize`, so the model is told how to use the tools
before it calls one.

## Notes worth stealing

- **A miss is not an error.** `close_ticket` on an unknown id sets
  `isError: true` in the tool result rather than throwing: the model reads the
  message and picks another id. Throwing is for the caller, `isError` is for the
  model. `catches:` is there when you do want a JSON-RPC error.
- **Tool descriptions are the interface.** `description` and `argumentsSchema`
  are the only things the model sees. `"The ticket id, as returned by
  search_tickets"` is what stops it inventing ids.
- **Stateless by default.** `Mcp.HttpEndpoint` mints no session unless
  `stateful: true`, so a tools-only server scales horizontally with no sticky
  routing.

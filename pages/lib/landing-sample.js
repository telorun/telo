// The manifests and terminal output shown on the landing page.
//
// Lives here rather than in the page component so `docusaurus.config.ts` can run
// each `manifest` through the same `<version>` substitution the docs get
// (pages/lib/version-map.js) before handing it to the browser bundle — the
// substitution reads the filesystem and cannot run client-side.
//
// EVERY `output` BLOCK IS TRANSCRIBED FROM A REAL RUN of the manifest beside it,
// not written by hand. If you change a manifest, re-run it and re-capture the
// output — a hand-edited pane drifts silently the first time a field is renamed.

const cases = [
  {
    id: "http",
    label: "HTTP API",
    blurb: "A server, a route with a validated response, and the handler behind it.",
    files: [
      {
        name: "telo.yaml",
        body: `kind: Telo.Application
metadata:
  name: GreetingApi
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref Server
ports:
  http: { env: PORT, default: 8080 }
---
kind: Http.Server
metadata:
  name: Server
port: !cel "ports.http"
mounts:
  - path: /v1
    mount: !ref Api
---
kind: Http.Api
metadata:
  name: Api
routes:
  - request: { path: /greet, method: GET }
    handler: !ref Greet
    returns:
      - status: 200
        content:
          application/json:
            body:
              message: !cel "result.message"
---
kind: Run.Value
metadata:
  name: Greet
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
value:
  message: Hello!
`,
      },
    ],
    output: `$ telo ./telo.yaml
Server listening at http://localhost:8080

$ curl localhost:8080/v1/greet
{"message":"Hello!"}
`,
  },
  {
    id: "database",
    label: "Database",
    blurb:
      "The same shape with somewhere to keep things. Values in !sql bind as parameters, so a quote in the input is a quote, never SQL.",
    files: [
      {
        name: "telo.yaml",
        body: `kind: Telo.Application
metadata:
  name: NotesApi
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Sql: oci://ghcr.io/telorun/sql@<version>
  SQLite: oci://ghcr.io/telorun/sql-sqlite@<version>
targets:
  - !ref Migrate
  - !ref Server
ports:
  http: { env: PORT, default: 8080 }
---
kind: SQLite.Connection
metadata:
  name: Db
file: ./notes.db
---
kind: Sql.Migrations
metadata:
  name: Migrate
connection: !ref Db
migrations:
  0001_create_notes:
    statement: |
      CREATE TABLE IF NOT EXISTS notes (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body  TEXT NOT NULL
      )
---
kind: Sql.Command
metadata:
  name: InsertNote
connection: !ref Db
---
kind: Sql.Query
metadata:
  name: ListNotes
connection: !ref Db
---
kind: Http.Server
metadata:
  name: Server
port: !cel "ports.http"
mounts:
  - path: /v1
    mount: !ref Notes
---
kind: Http.Api
metadata:
  name: Notes
routes:
  - request:
      path: /notes
      method: POST
      schema:
        body:
          type: object
          required: [title, body]
          properties:
            title: { type: string, minLength: 1 }
            body: { type: string }
    handler: !ref InsertNote
    inputs:
      sql: !sql "INSERT INTO notes (title, body)
                 VALUES (\${{ request.body.title }}, \${{ request.body.body }})"
    returns:
      - status: 201
        content:
          application/json:
            body:
              created: !cel "result.rowCount"

  - request: { path: /notes, method: GET }
    handler: !ref ListNotes
    inputs:
      sql: "SELECT id, title, body FROM notes ORDER BY id"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result.rows"
`,
      },
    ],
    output: `$ telo ./telo.yaml
Server listening at http://localhost:8080

$ curl -X POST localhost:8080/v1/notes \\
    -H 'content-type: application/json' \\
    -d '{"title":"first","body":"hello"}'
{"created":1}

$ curl localhost:8080/v1/notes
[{"id":1,"title":"first","body":"hello"}]
`,
  },
  {
    id: "batch",
    label: "Batch",
    blurb: "No server at all — a one-shot task that reads, aggregates, reports, and exits.",
    files: [
      {
        name: "telo.yaml",
        body: `kind: Telo.Application
metadata:
  name: SalesReport
imports:
  Fs: oci://ghcr.io/telorun/fs@<version>
  Collection: oci://ghcr.io/telorun/collection@<version>
  Run: oci://ghcr.io/telorun/run@<version>
  Console: oci://ghcr.io/telorun/console@<version>
targets:
  - !ref Report
---
kind: Run.Sequence
metadata:
  name: Report
steps:
  - name: Load
    invoke: { kind: Fs.File }
    inputs:
      path: ./orders.json

  - name: Sum
    invoke:
      kind: Collection.Summarize
      collection: !cel "inputs.orders"
      aggregate:
        orders: !cel "size(group)"
        revenue: !cel "sum(group.map(o, o.total))"
    inputs:
      orders: !cel "parseJson(steps.Load.result.content)"

  - name: Print
    invoke: !ref Console.writeLine
    inputs:
      output: !cel "string(steps.Sum.result.summary.orders) + ' orders, '
                    + string(steps.Sum.result.summary.revenue) + ' revenue'"
`,
      },
    ],
    output: `$ cat orders.json
[
  { "region": "eu", "total": 120.5 },
  { "region": "us", "total": 80.0 },
  { "region": "eu", "total": 45.25 }
]

$ telo ./telo.yaml
3 orders, 245.75 revenue
`,
  },
  {
    id: "config",
    label: "Config",
    blurb:
      "A one-shot task configured by the environment. Greeting declares the shape it returns, so the step that reads it is type-checked against that shape — a misspelled field is caught with the spelling you wanted.",
    files: [
      {
        name: "telo.yaml",
        body: `kind: Telo.Application
metadata:
  name: Welcome
imports:
  Run: oci://ghcr.io/telorun/run@<version>
  Console: oci://ghcr.io/telorun/console@<version>
variables:
  name:
    env: NAME
    type: string
    default: World
targets:
  - !ref Main
---
kind: Run.Value
metadata:
  name: Greeting
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
value:
  message: !cel "'Hello, ' + variables.name + '!'"
---
kind: Run.Sequence
metadata:
  name: Main
steps:
  - name: Build
    invoke: !ref Greeting

  - name: Say
    invoke: !ref Console.writeLine
    inputs:
      output: !cel "steps.Build.result.message"
`,
      },
    ],
    output: `$ NAME=Telo telo ./telo.yaml
Hello, Telo!

# Now misspell it: steps.Build.result.mesage

$ telo check ./telo.yaml

telo.yaml:38:20  error  Run.Sequence/Main:
  CEL at 'steps[1].inputs.output':
  'steps.Build.result.mesage' is not defined
  (available: message)
  CEL_UNKNOWN_FIELD

1 error
`,
  },
  {
    id: "library",
    label: "Library",
    blurb:
      "A Telo.Library is an importable unit — kinds, or ready-made instances like this one. Importing it is a relative path: no registry, no publish step, no build. Everything under exports: is what importers may reach; anything else stays private to the library.",
    files: [
      {
        name: "greeting/telo.yaml",
        body: `kind: Telo.Library
metadata:
  name: Greeting
imports:
  Run: oci://ghcr.io/telorun/run@<version>
exports:
  resources:
    - Formal
---
kind: Run.Value
metadata: { name: Formal }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [name]
    properties:
      name: { type: string }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
bindings:
  who: !cel "inputs.name"
value:
  message: !cel "'Good evening, ' + who + '.'"
`,
      },
      {
        name: "telo.yaml",
        body: `kind: Telo.Application
metadata:
  name: Welcome
imports:
  # A relative path. The library is loaded from disk, and its exported
  # instances are reachable as !ref Greeting.<name>.
  Greeting: ./greeting
  Console: oci://ghcr.io/telorun/console@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref Main
---
kind: Run.Sequence
metadata: { name: Main }
steps:
  - name: Evening
    invoke: !ref Greeting.Formal
    inputs: { name: Ada }

  - name: Say
    invoke: !ref Console.writeLine
    inputs:
      output: !cel "steps.Evening.result.message"
`,
      },
    ],
    output: `$ telo ./telo.yaml
Good evening, Ada.
`,
  },
  {
    id: "test",
    label: "Tests",
    blurb:
      "A test is an application. It includes the same routes the app serves, stands a real server up in a with: scope — a real socket, a real HTTP call, torn down when the sequence ends — and asserts against a plain expected value. No test framework and no mocks; the kernel that runs it is the one that runs production.",
    files: [
      {
        name: "api.yaml",
        body: `# The routes, in a partial file the application and its test both include —
# so the test exercises the real thing rather than a copy of it.
kind: Http.Api
metadata: { name: Api }
routes:
  - request: { path: /greet, method: GET }
    handler: !ref Greet
    returns:
      - status: 200
        content:
          application/json:
            body:
              message: !cel "result.message"
---
kind: Run.Value
metadata: { name: Greet }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
value:
  message: Hello!
`,
      },
      {
        name: "tests/greet-api.yaml",
        body: `kind: Telo.Application
metadata:
  name: GreetApiTest
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  HttpClient: oci://ghcr.io/telorun/http-client@<version>
  Run: oci://ghcr.io/telorun/run@<version>
  Assert: oci://ghcr.io/telorun/assert@<version>
include: [ ../api.yaml ]
logging:
  level: warn
targets:
  - !ref Test
---
kind: Run.Sequence
metadata: { name: Test }
# Created when the sequence starts, torn down when it ends — so the
# port is freed and the process exits on its own.
with:
  - kind: Http.Server
    metadata: { name: Server }
    host: 127.0.0.1
    port: 8973
    logger: false
    mounts:
      - { path: /v1, mount: !ref Api }
targets:
  - !ref Server
steps:
  - name: Call
    invoke:
      kind: HttpClient.Request
      url: http://127.0.0.1:8973/v1/greet
      method: GET

  - name: Check
    invoke: { kind: Assert.Equals }
    inputs:
      actual:
        status: !cel "steps.Call.result.status"
        body: !cel "steps.Call.result.body"
      expected:
        status: 200
        body: { message: Hello! }
`,
      },
    ],
    output: `$ telo ./tests/greet-api.yaml

Assert.Equals.SequenceTestSteps1Check: assertion passed
  \u2713 {"status":200,"body":{"message":"Hello!"}}

# Now change the expectation to "Hei!" and run it again.

$ telo ./tests/greet-api.yaml

Assert.Equals.SequenceTestSteps1Check: assertion failed
  \u2717 expected {"status":200,"body":{"message":"Hei!"}},
        got {"status":200,"body":{"message":"Hello!"}}

tests/greet-api.yaml  error  ERR_ASSERTION_FAILED

1 error   (exit 1)
`,
  },
  {
    id: "transaction",
    label: "Transactions",
    blurb:
      "Move declares that it must run inside a transaction. That is not a comment — telo check walks every path that can reach it and refuses the ones that would run it loose.",
    files: [
      {
        name: "telo.yaml",
        body: `kind: Telo.Application
metadata:
  name: Ledger
imports:
  Sql: oci://ghcr.io/telorun/sql@<version>
  SQLite: oci://ghcr.io/telorun/sql-sqlite@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref Migrate
  - !ref Main
---
kind: SQLite.Connection
metadata:
  name: Db
file: ./ledger.db
---
kind: Sql.Migrations
metadata:
  name: Migrate
connection: !ref Db
migrations:
  0001_accounts:
    statement: |
      CREATE TABLE IF NOT EXISTS accounts (
        name    TEXT PRIMARY KEY,
        balance INTEGER NOT NULL
      )
  0002_seed_accounts:
    statement: |
      INSERT OR IGNORE INTO accounts (name, balance)
      VALUES ('alice', 100), ('bob', 0)
---
kind: Run.Sequence
metadata:
  name: Main
steps:
  - name: Send
    invoke: !ref Transfer
    inputs:
      amount: 10
---
# Both writes land, or neither does.
kind: Sql.Transaction
metadata:
  name: Transfer
connection: !ref Db
steps: !ref TransferSteps
inputs:
  amount: !cel "inputs.amount"
---
kind: Run.Sequence
metadata:
  name: TransferSteps
steps:
  - name: Debit
    invoke: !ref Move
    inputs:
      sql: !sql "UPDATE accounts SET balance = balance - \${{ inputs.amount }}
                 WHERE name = 'alice'"
  - name: Credit
    invoke: !ref Move
    inputs:
      sql: !sql "UPDATE accounts SET balance = balance + \${{ inputs.amount }}
                 WHERE name = 'bob'"
---
# No connection: — it is reached through the transaction it declares.
kind: Sql.Command
metadata:
  name: Move
transaction: !ref Transfer
`,
      },
    ],
    output: `$ telo check ./telo.yaml
✓  No issues found

# Now run the statement outside the transaction —
# add "- !ref Move" to targets: and check again.

$ telo check ./telo.yaml

telo.yaml:11:10  error  Sql.Command 'Move' requires a
  SQL.Transaction zone on SQLite.Connection 'Db', and the path
  Move → Ledger.targets[2] reaches the application's boot targets,
  which nothing encloses. the statement would execute outside any
  transaction.  ZONE_REQUIREMENT_UNSATISFIED

1 error
`,
  },
];


module.exports = { cases };

---
"@telorun/studio": minor
---

Studio: the web build opens the Telo Cloud project a console link names. On `/?org=<org id>&project=<project id>[&module=<module path>]` it signs the visitor in to that organization when they are signed out or signed in to another, opens the project's working copy and, with `module`, that module, then removes the parameters from the address. A project it cannot open — unknown, or not the visitor's — and a module the project does not hold are reported instead of leaving an empty editor. Until now the parameters were ignored and the last workspace was restored.

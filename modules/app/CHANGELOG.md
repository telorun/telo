# Changelog

## 0.5.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.5.0 - 2026-10-25
### Added
* App.Instance gains needs: — fulfilments of the child's own needs, keyed by the child's need name, each a !ref to a need or fulfilment of this module handed over whole or a map of the need type's fields. The child answers a need supplied there before its own environment and host values, so a test gives each application it starts a durable directory of its own. Requires telo 0.123.0.
* App.Instance.source carries x-telo-application-source, so telo check follows it to the child application and refuses a source that is not an application, a name under variables, secrets, ports or needs the child does not declare, a literal its declaration refuses, a need of the wrong type or stating less than the child's, and one durable directory handed whole to two writers — wherever the instance is declared, before anything runs, where the child used to refuse it when it booted. An expression of the wrong type is refused statically only for an instance declared at the top level; in a with: scope or inline in a step the child still refuses it when it boots.

## 0.4.0 - 2026-10-23
### Added
* The `App.Instance` docs state that a child application does not inherit its parent's host values (`TELO_HOST_STATE_DIR` and the public URL templates), so a child's `Telo.DurableDirectory` need is supplied through its own variable.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-19
### Added
* App.Instance is a Channel.Text, so a running child can be read from and written to as text. BREAKING: the stdin: field is removed. A fixed script handed over at start-up cannot answer a question that only appears once the previous one is answered; sending is a step now, and a boot-time script is the first steps of a sequence.
* App.Instance runs another Telo application as a resource: supply its declared variables, secrets and ports by name, read its exit code as observed state, and have it shut down cleanly when the scope that declared it ends. An application cannot be imported, so this is how a manifest supervises several applications at once, and how a test reaches the file a user actually copies.

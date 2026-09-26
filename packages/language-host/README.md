# @telorun/language-host

The editor-side half of telo's language tooling: chooses the telo version each
module is edited against (from its `requires: telo:` ranges, or a pin), fetches
and verifies that version's engine (`@telorun/language-server`), and routes one
LSP endpoint across the engines in use. Browser-safe and version-agnostic; the
protocol it speaks to engines is [`@telorun/editor-protocol`](../editor-protocol/README.md).

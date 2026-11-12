---
"@telorun/analyzer": patch
"@telorun/kernel": patch
"@telorun/ide-support": patch
---

A kind that extends another is now read through one answer for everything derived along `extends` — its merged schema, observed-state block, throws, declared display messages, published fields, capability and rules — instead of values written over the declaration at registration, so a declaration always means what its author wrote and the kernel, the analyzer and the editor features cannot disagree about a derived value. A schema projection (`x-telo-schema-projection` or `-from`) is now inherited along merge-form `extends`: the nearest declarer wins, either form replaces what would be inherited, and a `base:` child, whose schema is its own, keeps declaring its own.

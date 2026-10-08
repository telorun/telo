---
"@telorun/kernel": patch
---

The compiled-validator cache key covers every registered shape a schema reaches by `$ref`. A contract whose own text was unchanged while a named shape it references changed was served the validator compiled before the change, so a correct resource was refused with `ERR_OUTPUT_INVALID` (or a wrong one accepted) until `.telo/validators/` was cleared.

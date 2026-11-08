---
"@telorun/analyzer": patch
---

A read of an imported instance's observed state (`resources.<Alias>.<name>.status.<field>`) is no longer refused as `OBSERVED_STATE_NEVER_RUN` when `targets:` starts that instance with `!ref <Alias>.<name>`; the diagnostic's suggested repair now names the instance alias-qualified.

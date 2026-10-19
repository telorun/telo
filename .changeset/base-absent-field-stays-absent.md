---
"@telorun/kernel": patch
"@telorun/cel": patch
---

A field left out of a resource now stays absent through every level of `base:` inheritance. A `base:` entry forwarding it (`accessToken: !cel "self.accessToken"`) wrote the key with no value, so a parent's own `base:` read `has(self.accessToken)` as true and failed with "+ was handed a value of no CEL type" — every connector client extending `GoogleAuth.GoogleClient` with a credential failed at boot. A failing `base:`, `inputs:` or `result:` expression now names the definition and field that wrote it (`in base.headers of GoogleAuth.GoogleClient (<source>)`), and CEL names `undefined` when a host hands it one instead of reporting a value of no CEL type.

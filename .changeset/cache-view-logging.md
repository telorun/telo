---
"@telorun/cache": patch
---

No change to the published contract — `CacheStore`, `CacheLookupResult` and `isCacheStore` are untouched.

The version moves because `Cache.View`'s controller now logs its lookup outcome and reports a failed revalidation, and the controller ships inside this package's directory even though it is bundled into the module artifact rather than exported from the npm entry point. Consumers of `@telorun/cache` have nothing to do.

---
"@telorun/analyzer": patch
---

A literal text a template body writes is judged in the language of the library that wrote it in each consumer's check as well, as the kernel settles it: a Polish body's `few` / `many` plural cases no longer report `MESSAGE_PLURAL_CATEGORY_INVALID` at an English application that uses the kind. A text the consumer forwards into the body is still judged in the consumer's language.

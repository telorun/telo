---
"@telorun/kernel": minor
---

Allow `metadata.categories` on module and kind docs — an unordered list of
domain display labels (`[AI, Storage]`) the hub groups its browse view by and
the editor filters its resource picker with. The vocabulary is open: the schema
constrains the shape (an array of strings) and nothing validates the values, so
a module can name a domain the standard library never anticipated. Consumers
that match across authorship boundaries derive their own key from the label —
the hub slugifies at index time, so `AI` and `ai` are one group.

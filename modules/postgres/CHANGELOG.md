# Changelog

## 0.1.0
### Added
* Initial release. Replaces `sql-postgres`, which is deprecated: the `sql-` prefix restated the abstract this module implements, which `extends` already records, and it stops being true now the module owns PostgreSQL-specific surface that is not a `sql` kind. The `Connection` kind and its schema are unchanged — consumers change one `imports:` entry and keep their alias and every `kind:` spelling.

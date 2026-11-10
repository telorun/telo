---
"@telorun/cli": minor
"@telorun/analyzer": minor
---

Inside a release workspace, `telo publish` and `telo release` write a relative import of another workspace module as that module's assigned destination (`oci://ghcr.io/telorun/sql@<version>#<pin>` from a blueprint's `../../modules/sql`), so modules at different depths and registry bases import each other relatively; `telo publish` refuses a destination the workspace does not assign (`destination_mismatch`) and a sibling the registry serves with other bytes than its pin (`import_pin_mismatch`), and `telo release` refuses a relative import of a manifest the workspace does not release (`IMPORT_TARGET_NOT_RELEASED`), replacing `IMPORT_DESTINATION_CONFLICT` and the analyzer's `checkImportDestinations` export.

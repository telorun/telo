---
"@telorun/editor-protocol": minor
"@telorun/language-host": minor
"@telorun/language-server": minor
"@telorun/analyzer": minor
"@telorun/cli": minor
"@telorun/studio": minor
---

A diagnostic that holds in some configurations of an application now carries `data.configurations` (and `telo check -o json` `configurations`) as partial assignments: one entry per block of the irredundant cover its message label is read off, each naming only the dimensions it narrows, so a finding in one flag's configurations no longer lists every assignment of the others. A dimension an entry leaves out holds every value; the finding holds in a configuration when some entry agrees with it on every key it names. The entries denote the same configurations as before, and the label is unchanged. The editor protocol generation is now 2 (`TELO_EDITOR_PROTOCOL`, `teloEditorProtocol`), because a host reading entries as complete assignments would misread them; a host speaks both generations, since a complete assignment reads correctly as a partial one, so every published engine is still offered. An application input's `requiredWhen` is evaluated the same way at the running configuration, and a reported dimension of a member carries its `member` (`telo module manifest --json`, `telo needs report`).

---
"@telorun/cli": patch
---

`telo run` no longer forwards the global `-o` / `--output` flag and its value into the application's own arguments. The flag is consumed by the CLI like `--inspect`; previously `telo ./app.yaml -o text` handed `-o text` to the kernel's argv.

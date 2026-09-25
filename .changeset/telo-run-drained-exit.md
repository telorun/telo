---
"@telorun/cli": minor
---

`telo run` exits 1, saying so on stderr, when the process runs out of work before the application finishes — a wait nothing can resolve used to end the run with exit code 0 and no further output, so a test suite whose last test hung reported success without its summary.

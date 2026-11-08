---
"@telorun/kernel": minor
"@telorun/cli": minor
---

The Node kernel records application startup as one trace span, `startup <application name>`, from the process start `telo run` passes (a kernel started any other way, from its creation) to the end of the init loop. It is exported with its real start time when a trace sink is attached and never created otherwise.

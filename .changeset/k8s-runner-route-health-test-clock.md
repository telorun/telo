---
"@telorun/k8s-runner": patch
---

Route-health's "a verdict clears a retained read error" test runs on virtual time. It needed two polls inside an 8 ms real-time deadline, so a scheduling stall in the first iteration ended the watch with the read failure still retained and CI failed at random on a message the test exists to rule out. No runtime change.

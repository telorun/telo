---
"@telorun/studio": minor
---

An app that asks to open a page (`Telo.OpenUrl`) now gets it opened by Studio at the address you can reach it on: a dialog asks "Open <app> in another tab?" for a run you started, with an "Always open this app" choice per workspace and app, and a page on another site always asks first. A run Studio did not start, such as one still live after a reload, shows the link in the run dock instead of asking, and an address that is not one of the app's declared ports is shown and never opened.

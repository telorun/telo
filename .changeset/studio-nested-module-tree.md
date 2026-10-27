---
"@telorun/studio": minor
---

The sidebar shows modules nested in another module's directory (a test application in an application, a library in an application) as a tree under their parent, and deleting a module, or its `telo.yaml` in the file explorer, deletes its directory with every module nested in it, pruning the imports of those modules from the modules outside them.

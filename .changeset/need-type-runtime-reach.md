---
"@telorun/kernel": minor
"@telorun/cli": patch
---

`telo module manifest --json` reports a need type's runtime reach. A `Telo.NeedType` declares a kind the kernel serves with its own need-type controller, and `runtime.kinds` now lists it as the kernels that register that controller — `{ runtimes: [nodejs], languages: [], portable: false }` today — where it used to be missing, so the hub stored every need type as runnable by no kernel and a `runtime` filter hid it. Which documents declare a kind is read through the analyzer's `kindDeclarationOf`, and a kernel candidate `{ runtime: kernel, entry }` is hosted by exactly the kernels registering `entry`: `@telorun/kernel` exports the entries it registers at boot as `BUILTIN_CONTROLLER_ENTRIES`, the keys of the one table it registers its built-in controllers from. A `Telo.Builtins` root still reports `runtime: null`.

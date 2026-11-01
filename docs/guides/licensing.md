---
description: "Telo's licences in plain terms — what is free, what you can build and sell on it, what needs a commercial licence, and which parts are MIT."
---

# Licensing

Telo is free to use, including for commercial work. One thing is reserved: you
may not sell Telo itself as a hosted service. This page says what that means in
plain terms. It is a summary, not legal advice; the licence texts decide.

## What is free

Everything in the repository is free of charge to download, read, run, modify
and distribute, commercial use included. The software comes with no warranty.

## What you can do

- Build an application on Telo and sell it, or run it inside your own company.
- Host it yourself, on your own servers or in your own cloud account.
- Modify the runtime for your own use.
- Charge your customers for your product, including when it runs on Telo.

## What you cannot do without a commercial licence

You may not offer **Telo itself** to other people as a managed service — a
hosted Telo platform, "Telo as a service", or a backend-as-a-service whose main
value to the customer is the functionality of Telo. If you want to do that,
contact CodeNet Sp. z o.o. for a commercial licence (below).

This restriction is about reselling Telo. It does not apply to an application you
build that happens to run on Telo.

## Two licences, and why that matters

| Licence | Covers | Why it matters to you |
| --- | --- | --- |
| **MIT** | The standard-library modules you build with, the SDK for writing your own modules, the expression engine, the documentation, the examples and the starters | Anything you write against these is entirely yours. MIT places almost no conditions on it. |
| **Sustainable Use** ("fair-code") | The runtime that loads, checks and runs your application, the command-line tool, the editor tooling, Studio and the runners | The source is public and free to use, but the resale restriction above applies. |

"Fair-code" and "source-available" mean the same here: you can read and use the
code, but it is not "open source" in the strict sense, because of the resale
restriction.

Your application's own files stay in your repository and are yours. No MIT
package depends on a Sustainable Use one, which an automated check enforces. The
exact list of directories under each licence is in the
[README](https://github.com/telorun/telo#license).

## Contact

Commercial licensing, managed-hosting exemptions and enterprise inquiries:
[contact@codenet.pl](mailto:contact@codenet.pl). The copyright holder is
CodeNet Sp. z o.o.

The full text is the [Sustainable Use License](https://github.com/telorun/telo/blob/main/LICENSE)
at the repository root.

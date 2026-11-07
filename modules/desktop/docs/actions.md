# Actions

An action is `{ invoke, inputs? }`: it dispatches any invocable of the application as an inbound trigger, the way a schedule fires its body. `inputs` are evaluated on each run and checked by `telo check` against the invocable's contract.

```yaml
action:
  invoke: !ref Console.writeLine
  inputs: { output: Hello is running }
```

`invoke` is a `!ref` to a declared resource or an inline resource. A failing action is logged with its error and the menu stays usable; the host is not told.

Two invocables cover what every tray needs:

- `Desktop.ShowWindow` (`window:` a `Desktop.Window`) shows and focuses it.
- `Desktop.Quit` (`host:` the `Telo.DesktopHost` need) asks the host for the same graceful stop as a termination signal. The host closes the connection, which releases the application's holds.

A `Desktop.ShowWindow` or `Desktop.Quit` can also run from any other trigger, such as a step of a `Telo.Sequence`.

# telo-kernel

## 0.2.8

### Patch Changes

- Updated dependencies [a434722]
- Updated dependencies [c8d457b]
  - @telorun/analyzer@0.58.0
  - @telorun/ide-support@0.13.0
  - @telorun/kernel@0.73.0

## 0.2.7

### Patch Changes

- Updated dependencies [55a7bef]
- Updated dependencies [e801bd2]
  - @telorun/analyzer@0.57.0
  - @telorun/ide-support@0.12.0
  - @telorun/kernel@0.72.0

## 0.2.6

### Patch Changes

- Updated dependencies [0ea1b8b]
- Updated dependencies [0ea1b8b]
- Updated dependencies [07fca98]
  - @telorun/kernel@0.70.0
  - @telorun/analyzer@0.56.1
  - @telorun/ide-support@0.11.3

## 0.2.5

### Patch Changes

- Updated dependencies [8cede51]
  - @telorun/analyzer@0.56.0
  - @telorun/kernel@0.69.0
  - @telorun/ide-support@0.11.2

## 0.2.4

### Patch Changes

- Updated dependencies [2373398]
- Updated dependencies [2373398]
- Updated dependencies [2373398]
  - @telorun/kernel@0.68.0
  - @telorun/analyzer@0.55.0
  - @telorun/ide-support@0.11.1

## 0.2.3

### Patch Changes

- Updated dependencies [8a9b494]
- Updated dependencies [e7853d5]
- Updated dependencies [0938ed4]
  - @telorun/kernel@0.67.0
  - @telorun/analyzer@0.54.0
  - @telorun/ide-support@0.11.0

## 0.2.2

### Patch Changes

- Updated dependencies [3bd2de9]
- Updated dependencies [0b971d6]
  - @telorun/analyzer@0.53.0
  - @telorun/kernel@0.66.0
  - @telorun/ide-support@0.10.1

## 0.2.1

### Patch Changes

- Updated dependencies [bd6398e]
- Updated dependencies [f94ff85]
- Updated dependencies [0bbbc3f]
  - @telorun/ide-support@0.10.0
  - @telorun/analyzer@0.52.0
  - @telorun/kernel@0.65.0

## 0.2.0

### Minor Changes

- 7edc69d: Remove the `telo.registryUrl` setting from the VS Code extension.

  The setting overrode the base URL of the module registry that resolves imports during analysis. Import resolution now uses the kernel transport registry's own default, so `registry://` and bare refs resolve exactly as they do under `telo check` with no configuration. Nothing else read the setting — `telo.hubUrl`, which drives federated import autocomplete and the upgrade lenses, is a separate concern and is unchanged.

### Patch Changes

- Updated dependencies [c28ee72]
- Updated dependencies [424aacf]
- Updated dependencies [a8402d9]
  - @telorun/ide-support@0.9.0
  - @telorun/analyzer@0.51.0
  - @telorun/kernel@0.64.0

## 0.1.0

### Minor Changes

- 3e9f802: Surface outdated `imports:` entries in the IDE, the way the telo editor's Imports view already does.

  `@telorun/analyzer` gains `newestModuleVersion(versions, { includePrerelease })` beside `isNewerModuleVersion`. Both halves of an upgrade check have to come from one rule: a host that decides "behind" through the shared ordering but reads "latest" off the head of a version list is answering with whatever order its index happened to return. For a module whose newest tag is a prerelease, list-order said the import was behind while the ordering rule said it was current — the same manifest against the same hub, two answers. Unparseable tags (an OCI digest, a moving `latest`) are dropped rather than ordered, and prereleases are excluded unless asked for, matching `telo upgrade`'s default. The editor's Imports view now derives its "latest" through it, so its badge no longer offers `-rc` builds as automatic upgrade targets; the per-import dropdown still lists every version for a deliberate pick.

  `@telorun/ide-support` gains `buildImportUpgrades(text, listVersions, docs?)` — a host-neutral builder that locates every `imports:` entry of a module document, asks a caller-supplied `ModuleVersionLookup` for each distinct base ref's versions, and returns the source edits that re-point the ones that are behind. Both authored shapes are handled: for the object form the now-stale `integrity:` line is deleted alongside the source rewrite, because the pin hashes the `telo.yaml` of the version being replaced and carrying it forward would turn the next install into a tamper error. An entry whose pin shares a line with other fields is reported as a skip — carrying its anchor and versions, so a host renders it in place of the upgrade affordance rather than showing nothing for an import that is behind.

  The VS Code extension renders it as CodeLenses: a summary lens on the `imports:` key (`2 imports outdated · Upgrade all`), a per-entry lens (`↑ 0.9.0 → 1.0.0`), and a warning lens for a skip. Version lists come from the hub, memoized so lens resolution stays off the keystroke path — failures are memoized too, on a shorter clock, or an unreachable hub would fire a request per base ref on every keystroke. A click that changes nothing now says which of the three reasons applied: a lookup that failed, a skip that named a reason, or genuinely current. Hub failures go to a new `Telo` output channel, reachable from the failure notification. New setting `telo.importUpgrades.enabled` turns the feature and its hub traffic off; new command `Telo: Check Imports for Updates` drops the memo and re-checks.

  `@telorun/cli` drops its private copy of the module-kind list in favour of the analyzer's `isModuleKind`.

### Patch Changes

- Updated dependencies [e52a2bf]
- Updated dependencies [e52a2bf]
- Updated dependencies [3e9f802]
  - @telorun/analyzer@0.50.0
  - @telorun/kernel@0.63.0
  - @telorun/ide-support@0.8.0

## 0.0.76

### Patch Changes

- Updated dependencies [15acf14]
- Updated dependencies [89ffea7]
- Updated dependencies [89ffea7]
- Updated dependencies [89ffea7]
  - @telorun/kernel@0.62.0
  - @telorun/analyzer@0.49.1
  - @telorun/ide-support@0.7.10

## 0.0.75

### Patch Changes

- Updated dependencies [bf324d2]
- Updated dependencies [2ee3598]
- Updated dependencies [bf324d2]
- Updated dependencies [bf324d2]
  - @telorun/kernel@0.61.0
  - @telorun/analyzer@0.49.0
  - @telorun/ide-support@0.7.9

## 0.0.74

### Patch Changes

- Updated dependencies [d23de89]
  - @telorun/analyzer@0.48.0
  - @telorun/kernel@0.60.0
  - @telorun/ide-support@0.7.8

## 0.0.73

### Patch Changes

- Updated dependencies [6376a66]
- Updated dependencies [6376a66]
- Updated dependencies [6376a66]
  - @telorun/analyzer@0.47.0
  - @telorun/kernel@0.59.0
  - @telorun/ide-support@0.7.7

## 0.0.72

### Patch Changes

- Updated dependencies [8353d0e]
  - @telorun/kernel@0.58.0
  - @telorun/analyzer@0.46.0
  - @telorun/ide-support@0.7.6

## 0.0.71

### Patch Changes

- Updated dependencies [3729559]
  - @telorun/analyzer@0.45.0
  - @telorun/kernel@0.57.0
  - @telorun/ide-support@0.7.5

## 0.0.70

### Patch Changes

- Updated dependencies [f3b044d]
  - @telorun/analyzer@0.44.0
  - @telorun/kernel@0.56.0
  - @telorun/ide-support@0.7.4

## 0.0.69

### Patch Changes

- Updated dependencies [cae53b0]
  - @telorun/kernel@0.55.0

## 0.0.68

### Patch Changes

- Updated dependencies [942c176]
- Updated dependencies [adc8459]
- Updated dependencies [adc8459]
  - @telorun/kernel@0.54.0
  - @telorun/analyzer@0.43.0
  - @telorun/ide-support@0.7.3

## 0.0.67

### Patch Changes

- Updated dependencies [de6c2aa]
  - @telorun/kernel@0.53.0
  - @telorun/analyzer@0.42.0
  - @telorun/ide-support@0.7.2

## 0.0.66

### Patch Changes

- Updated dependencies [84002d3]
  - @telorun/kernel@0.52.0
  - @telorun/analyzer@0.41.1
  - @telorun/ide-support@0.7.1

## 0.0.65

### Patch Changes

- Updated dependencies [0c1c8fd]
- Updated dependencies [2e1bb5c]
  - @telorun/analyzer@0.41.0
  - @telorun/ide-support@0.7.0
  - @telorun/kernel@0.51.2

## 0.0.64

### Patch Changes

- Updated dependencies [bdc21e9]
  - @telorun/ide-support@0.6.0

## 0.0.63

### Patch Changes

- Updated dependencies [6418e2a]
- Updated dependencies [6418e2a]
- Updated dependencies [6418e2a]
  - @telorun/kernel@0.51.0
  - @telorun/analyzer@0.40.0
  - @telorun/ide-support@0.5.0

## 0.0.62

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/analyzer@0.39.0
  - @telorun/ide-support@0.4.45

## 0.0.61

### Patch Changes

- Updated dependencies [0368e6f]
- Updated dependencies [8af345f]
  - @telorun/analyzer@0.38.0
  - @telorun/ide-support@0.4.44

## 0.0.60

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/analyzer@0.37.0
  - @telorun/ide-support@0.4.43

## 0.0.59

### Patch Changes

- Updated dependencies [bd4f3ac]
  - @telorun/analyzer@0.36.0
  - @telorun/ide-support@0.4.42

## 0.0.58

### Patch Changes

- Updated dependencies [56c810b]
- Updated dependencies [d88a397]
  - @telorun/analyzer@0.35.0
  - @telorun/ide-support@0.4.41

## 0.0.57

### Patch Changes

- Updated dependencies [cd3ec0b]
  - @telorun/analyzer@0.34.1
  - @telorun/ide-support@0.4.40

## 0.0.56

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/analyzer@0.34.0
  - @telorun/ide-support@0.4.39

## 0.0.55

### Patch Changes

- Updated dependencies [3961e35]
- Updated dependencies [b5a325f]
- Updated dependencies [9a92bf1]
  - @telorun/analyzer@0.33.0
  - @telorun/ide-support@0.4.38

## 0.0.54

### Patch Changes

- Updated dependencies [2ff9027]
  - @telorun/analyzer@0.32.0
  - @telorun/ide-support@0.4.37

## 0.0.53

### Patch Changes

- Updated dependencies [36af5f5]
  - @telorun/analyzer@0.31.0
  - @telorun/ide-support@0.4.36

## 0.0.52

### Patch Changes

- Updated dependencies [5dd71ee]
  - @telorun/analyzer@0.30.1
  - @telorun/ide-support@0.4.35

## 0.0.51

### Patch Changes

- Updated dependencies [2d9323c]
- Updated dependencies [4e5d861]
  - @telorun/analyzer@0.30.0
  - @telorun/ide-support@0.4.34

## 0.0.50

### Patch Changes

- Updated dependencies [ebca26a]
  - @telorun/analyzer@0.29.0
  - @telorun/ide-support@0.4.33

## 0.0.49

### Patch Changes

- Updated dependencies [a9ac4ba]
  - @telorun/analyzer@0.28.1
  - @telorun/ide-support@0.4.32

## 0.0.48

### Patch Changes

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0
  - @telorun/ide-support@0.4.31

## 0.0.47

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/analyzer@0.27.0
  - @telorun/ide-support@0.4.30

## 0.0.46

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0
  - @telorun/ide-support@0.4.29

## 0.0.45

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/analyzer@0.25.0
  - @telorun/ide-support@0.4.28

## 0.0.44

### Patch Changes

- @telorun/analyzer@0.24.1
- @telorun/ide-support@0.4.27

## 0.0.43

### Patch Changes

- Updated dependencies [aaa760d]
  - @telorun/analyzer@0.24.0
  - @telorun/ide-support@0.4.26

## 0.0.42

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2
  - @telorun/ide-support@0.4.25

## 0.0.41

### Patch Changes

- Updated dependencies [5973024]
  - @telorun/analyzer@0.23.1
  - @telorun/ide-support@0.4.24

## 0.0.40

### Patch Changes

- Updated dependencies [c89e79b]
- Updated dependencies [4794671]
  - @telorun/analyzer@0.23.0
  - @telorun/ide-support@0.4.23

## 0.0.39

### Patch Changes

- Updated dependencies [ee8926f]
  - @telorun/analyzer@0.22.0
  - @telorun/ide-support@0.4.22

## 0.0.38

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/analyzer@0.21.0
  - @telorun/ide-support@0.4.21

## 0.0.37

### Patch Changes

- Updated dependencies [06cfcbf]
  - @telorun/analyzer@0.20.0
  - @telorun/ide-support@0.4.20

## 0.0.36

### Patch Changes

- @telorun/analyzer@0.19.1
- @telorun/ide-support@0.4.19

## 0.0.35

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0
  - @telorun/ide-support@0.4.18

## 0.0.34

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/ide-support@0.4.17

## 0.0.33

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0
  - @telorun/ide-support@0.4.16

## 0.0.32

### Patch Changes

- Updated dependencies [0505e9b]
  - @telorun/ide-support@0.4.15

## 0.0.31

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1
  - @telorun/ide-support@0.4.14

## 0.0.30

### Patch Changes

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/ide-support@0.4.13

## 0.0.29

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/ide-support@0.4.12

## 0.0.28

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/analyzer@1.0.0
  - @telorun/ide-support@0.4.11

## 0.0.27

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/analyzer@0.13.0
  - @telorun/ide-support@0.4.10

## 0.0.26

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1
  - @telorun/ide-support@0.4.9

## 0.0.25

### Patch Changes

- Updated dependencies [c0129c0]
  - @telorun/analyzer@1.5.0
  - @telorun/ide-support@0.4.8

## 0.0.24

### Patch Changes

- Updated dependencies [0331069]
  - @telorun/analyzer@1.4.0
  - @telorun/ide-support@0.4.7

## 0.0.23

### Patch Changes

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]
  - @telorun/analyzer@1.3.0
  - @telorun/ide-support@0.4.6

## 0.0.22

### Patch Changes

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]
  - @telorun/analyzer@1.2.0
  - @telorun/ide-support@0.4.5

## 0.0.21

### Patch Changes

- Updated dependencies [39aef08]
  - @telorun/analyzer@1.1.0
  - @telorun/ide-support@0.4.4

## 0.0.20

### Patch Changes

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/analyzer@1.0.0
  - @telorun/ide-support@0.4.3

## 0.0.19

### Patch Changes

- Updated dependencies [0f80fc5]
  - @telorun/analyzer@0.11.0
  - @telorun/ide-support@0.4.2

## 0.0.18

### Patch Changes

- @telorun/analyzer@0.10.1
- @telorun/ide-support@0.4.1

## 0.0.17

### Patch Changes

- Updated dependencies [d9df589]
- Updated dependencies [65647e0]
  - @telorun/ide-support@0.4.0
  - @telorun/analyzer@0.10.0

## 0.0.16

### Patch Changes

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
  - @telorun/analyzer@0.9.0
  - @telorun/ide-support@0.3.0

## 0.0.15

### Patch Changes

- ec5b1b1: Register a `telo` language id and auto-promote yaml manifests to it so Red Hat's YAML extension stops firing `!cel` / `!literal` "unresolved tag" warnings on Telo manifests. Includes a stub TextMate grammar that delegates to `source.yaml` for highlighting and a basic language-configuration for brackets, comments, and indentation.
- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1
  - @telorun/ide-support@0.2.7

## 0.0.14

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0
  - @telorun/ide-support@0.2.6

## 0.0.13

### Patch Changes

- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0
  - @telorun/ide-support@0.2.5

## 0.0.12

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1
  - @telorun/ide-support@0.2.4

## 0.0.11

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/analyzer@0.6.0
  - @telorun/ide-support@0.2.3

## 0.0.10

### Patch Changes

- Updated dependencies [2e0ad31]
  - @telorun/analyzer@0.5.0
  - @telorun/ide-support@0.2.2

## 0.0.9

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0
  - @telorun/ide-support@0.2.1

## 0.0.8

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
  - @telorun/ide-support@0.2.0

## 0.0.7

### Patch Changes

- @telorun/analyzer@0.2.1

## 0.0.6

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/analyzer@0.2.0

## 0.0.5

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.4

## 0.0.4

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.3

## 0.0.3

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.2

## 0.0.2

### Patch Changes

- Updated dependencies
  - @telorun/analyzer@0.1.1

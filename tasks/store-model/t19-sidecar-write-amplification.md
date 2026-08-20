# T19 — the sidecar stops being one file

**Status: optional.** Nothing depends on this. It is a performance ceiling, not a
correctness problem, and the store is correct on either side of it.

Read [README.md](README.md) first.

## The measurement

`fsStore` keeps its whole index in memory and rewrites `.jfs/index.json` whole on
every commit — `save()` serializes every entry and publishes the file. Measured on
this branch (macOS, APFS, `--expose-gc`, heap sampled around the opening scan):

| files | heap | bytes/row | sidecar | one single-row commit |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.6 MB | 1601 | 0.53 MB | 2.9 ms |
| 10,000 | 9.8 MB | 971 | 5.31 MB | 7.9 ms |
| 30,000 | 25.8 MB | 852 | 16 MB | 31.8 ms |

Both curves are straight. Per-row heap converges to about **850 bytes**; the
sidecar is a steady **~528 bytes/row**.

The heap column is survivable. The last column is the ceiling: changing one row in
a 30k-file tree writes 16 MB, because a commit awaits a `save` that has no
incremental path. Extrapolated:

| files | heap | written per commit | per commit |
| ---: | ---: | ---: | ---: |
| 100,000 | ~85 MB | ~53 MB | ~105 ms |
| 300,000 | ~255 MB | ~158 MB | ~320 ms |
| 1,000,000 | ~850 MB | ~530 MB | ~1 s |

At a million files, saving one file writes half a gigabyte. That is not slow, it
is broken — and it burns SSD write endurance while it is at it.

## Where the wall is

Comfortable to ~50k files. Uncomfortable at ~100k. Unusable past ~300k.

For scale: the Linux kernel tree is ~80k files; a large `node_modules` is
100–300k. The wall sits at the size of a realistic project rather than far beyond
it. `fs.ts` already says this backend "serves a working tree, not a
warehouse" — this task is about writing the number down and, if it matters,
moving it.

## Prior art

Git's index is also a whole-file rewrite, which is fine because git is
per-command rather than continuous. When that stopped being fine the answer was
`core.splitIndex`: a base index plus small incremental ones, merged on a
threshold. (Same subsystem as git's racy-clean handling — the split-index work had
to teach it how to carry racily-clean entries across the split, which is the same
problem `unchanged` solves here.) Syncthing sidesteps it by keeping its index in
a database rather than a file.

## Two ways, either is fine

- **Append and compact.** Commits append their changed entries to a log; a full
  index is rewritten when the log outgrows some fraction of it. Cheapest write
  path; recovery replays the log over the base.
- **Base plus delta.** Git's shape. A base index plus a small overlay, merged on
  a threshold.

## Before starting

- Decide it is worth it. The number above is the argument, and "a working tree,
  not a warehouse" may simply be the right answer — in which case close this and
  write the ceiling into the module header instead.
- Whatever lands must keep the crash model `fs.ts` documents: a half-written
  sidecar must never lose ids, which is what the publish-and-rename buys today.
- `load()` must keep the distinction it fought for — only "not there" means a
  tree with no history; anything else throws (`disk.bytes(index, true)`).

## Done when

- A single-row commit's cost stops growing with the size of the tree, shown by a
  benchmark in the repo rather than a claim.
- The conformance suite, `store.fs.test.ts`, and the property tests in
  `store.fs.model.test.ts` all still pass — the last of these especially, since a
  reopen reading a compacted index is exactly what it checks.

# Changelog

## [0.5.0](https://github.com/xiaoxinghu/justfiles/compare/fs-v0.4.0...fs-v0.5.0) (2026-07-31)


### ⚠ BREAKING CHANGES

* **fs:** `Volume.rename` no longer takes `{ exclusive }`, and `caps.atomicMove` has no `noReplace`. Callers that must not overwrite a destination check it themselves and order their own claims — see `claimPath` in packages/app-notes.

### Features

* **agent:** stable per-host deviceId (shard naming prerequisite) ([#326](https://github.com/xiaoxinghu/justfiles/issues/326)) ([2589c14](https://github.com/xiaoxinghu/justfiles/commit/2589c14b5cabfbf4102b4af1be0be12cb13d7490))
* **fs,app:** a /private root — credentials never replicate ([#307](https://github.com/xiaoxinghu/justfiles/issues/307)) ([65a42f5](https://github.com/xiaoxinghu/justfiles/commit/65a42f50db54e128fe1c781a76429d380c7056ac)), closes [#291](https://github.com/xiaoxinghu/justfiles/issues/291)
* **fs:** atomicCreate carries its content — a create publishes bytes and name as one fact ([#325](https://github.com/xiaoxinghu/justfiles/issues/325)) ([44d77be](https://github.com/xiaoxinghu/justfiles/commit/44d77be9e3189d2adc60307c1ac4d518491837a4))


### Bug Fixes

* **fs:** a plain writeFile is create-or-overwrite on every backend, and every backend's claim is atomic ([#327](https://github.com/xiaoxinghu/justfiles/issues/327)) ([0314818](https://github.com/xiaoxinghu/justfiles/commit/031481859f1ed8cc80d963efbcb9aca00fd7608d))
* **fs:** a pulled edit is an edit, not a change of shape ([a47a956](https://github.com/xiaoxinghu/justfiles/commit/a47a956f9c6b0da4f3083dbb3be048078afcb3c5))
* **fs:** a recursive watch wakes for its own subtree, not the whole volume ([e68c433](https://github.com/xiaoxinghu/justfiles/commit/e68c433cf5fe6a8a4bec889d4982f01222965446))
* **fs:** a subtree moved out from under a watch is a change to that subtree ([9826266](https://github.com/xiaoxinghu/justfiles/commit/98262668dfa053a2ca257651521e7a9ed4bdcfc1))
* **fs:** compare a watch root by where it lands, and land trailing .. correctly ([80c71ac](https://github.com/xiaoxinghu/justfiles/commit/80c71acdb648e7887008470bf394789e790005a1))
* **fs:** compare watch paths the way every other operation resolves them ([e8854e8](https://github.com/xiaoxinghu/justfiles/commit/e8854e88a517862dcac8cec565a6fedba98a8bce))
* **fs:** mtime is when the bytes changed, not when the file appeared ([5ce1477](https://github.com/xiaoxinghu/justfiles/commit/5ce1477766dd4ad881699745631405e0d6c9cbf9))
* **fs:** read a symlink's target back on nativeStorage ([#329](https://github.com/xiaoxinghu/justfiles/issues/329)) ([#344](https://github.com/xiaoxinghu/justfiles/issues/344)) ([3e1e7c4](https://github.com/xiaoxinghu/justfiles/commit/3e1e7c471b6dbb3e9a5b8248072c3bfbb8492735))
* **fs:** the backend stages a create's content inside its own claim, not the VFS beforehand ([#332](https://github.com/xiaoxinghu/justfiles/issues/332)) ([f3a8eab](https://github.com/xiaoxinghu/justfiles/commit/f3a8eabc8c17ad2f26215eadd041271558d93029))
* **fs:** write-then-publish — close the create-then-fill visibility gap ([#321](https://github.com/xiaoxinghu/justfiles/issues/321)) ([#322](https://github.com/xiaoxinghu/justfiles/issues/322)) ([c268df5](https://github.com/xiaoxinghu/justfiles/commit/c268df58149a23a2c13dd8ca6d4b00c8faf327ae))


### Code Refactoring

* **fs:** rename has no exclusive form — POSIX shape, and backends that don't corrupt behind it ([#336](https://github.com/xiaoxinghu/justfiles/issues/336)) ([8bf59c9](https://github.com/xiaoxinghu/justfiles/commit/8bf59c963ecb2ebe4d8ea0403fc8ae8694b6b889))

## [0.4.0](https://github.com/xiaoxinghu/justfiles/compare/fs-v0.3.0...fs-v0.4.0) (2026-07-24)


### Features

* **fs:** proactive, fs-level sync driven by the volume change feed ([29f4cb0](https://github.com/xiaoxinghu/justfiles/commit/29f4cb08dfc8afe0686c8de7214effb22a9c651e))


### Bug Fixes

* **fs,frieren:** address PR review — full drain per cycle + /ws self-heal ([53d0853](https://github.com/xiaoxinghu/justfiles/commit/53d0853c0f0364bbb7079a611afac7fe5e192e14))
* **fs:** address 2nd PR review — non-destructive legacy re-bootstrap + lineage write-fence ([95f7a91](https://github.com/xiaoxinghu/justfiles/commit/95f7a918713b448a52b3bcdd1e4f310d0c157d55))
* **fs:** address 3rd PR review — republish pulled files, verify pending lineage, identity-aware fence ([1a7a510](https://github.com/xiaoxinghu/justfiles/commit/1a7a51029322222380107a331778037cde2ffcfe))
* **fs:** address 4th PR review — fence adopt-mine by lineage + restart-safe migrations ([05360fa](https://github.com/xiaoxinghu/justfiles/commit/05360fab2fd49d88cf80fb69a502e62d6680c2b6))
* **fs:** address PR review — lineage gate ordering + legacy cursor safety ([624ce6f](https://github.com/xiaoxinghu/justfiles/commit/624ce6fe7cd0ba37fb7ed8c2e07c237e565bc635))
* **fs:** converge path-sync via unique lineage identity ([9b3c021](https://github.com/xiaoxinghu/justfiles/commit/9b3c021132e3d710ea5ef801fd9929191b6b6df2))
* **fs:** converge path-sync via unique lineage identity ([56c9232](https://github.com/xiaoxinghu/justfiles/commit/56c9232dca3056be29adfe3a4de9472be6b8267c)), closes [#245](https://github.com/xiaoxinghu/justfiles/issues/245)
* **fs:** skip orphaned blobs during sync ([d70a2ec](https://github.com/xiaoxinghu/justfiles/commit/d70a2ec9d0a7d99ed884a71360869ae15cc0cf93))
* **fs:** skip orphaned blobs during sync ([a6b0f5a](https://github.com/xiaoxinghu/justfiles/commit/a6b0f5a264d529d3227f6a2b56b63b73f2f05edf))

## [0.3.0](https://github.com/xiaoxinghu/justfiles/compare/fs-v0.2.1...fs-v0.3.0) (2026-07-16)


### Features

* **app-files:** auto-refresh the file tree on volume changes ([256dcdc](https://github.com/xiaoxinghu/justfiles/commit/256dcdcad0347e0e36769b1331dfc20a6963f56c))
* **core:** sqlite path-sync journal + local-mutation journaling (slice 3) ([8e6b5b1](https://github.com/xiaoxinghu/justfiles/commit/8e6b5b1c6335156d5c8c009714eecd117b7ca462))
* **design:** introduce new design system ([26e5505](https://github.com/xiaoxinghu/justfiles/commit/26e5505ed0b09f408e782df8d40d8abb28f328ce))
* **frieren:** add PWA offline boot support ([efa3d4d](https://github.com/xiaoxinghu/justfiles/commit/efa3d4de374a4f66df03855db556d12f34506454))
* **frieren:** add synced local filesystem ([387368c](https://github.com/xiaoxinghu/justfiles/commit/387368c3bda748550657feba04c18deec20792b4))
* **frieren:** boot desktop without auth ([90f9872](https://github.com/xiaoxinghu/justfiles/commit/90f987222be52b379414ffc660612916c005c2e7))
* **frieren:** local profiles own local storage (Phase 4b) ([934c6a4](https://github.com/xiaoxinghu/justfiles/commit/934c6a4a527e488e8a5c0ed97b7b1db06dd1a4f1))
* **frieren:** local-first Phase 2b — default local execution + volume.watch ([b77b4c0](https://github.com/xiaoxinghu/justfiles/commit/b77b4c01571c10dc6ab664bacb9e1285aeaef920))
* **fs:** content-hash-addressed storage + replica blob store ([b367d4b](https://github.com/xiaoxinghu/justfiles/commit/b367d4b0407d8de30ffba92541a97b14848623fa))
* **fs:** deterministic LWW in applyPathChanges ([e24053c](https://github.com/xiaoxinghu/justfiles/commit/e24053cd49ba27f5ae636a6683eca6b54ba804a5))
* **fs:** enforce /.state exclusion in localSyncReplica change source ([5cffa8e](https://github.com/xiaoxinghu/justfiles/commit/5cffa8ee25e275ee1a8534073e9a18876a216225))
* **fs:** explicit-version mutations pin path_version ([9b13d91](https://github.com/xiaoxinghu/justfiles/commit/9b13d914a94b72a48524a660c2143d471b736dd2))
* **fs:** implement changeDigest conflict tie-break ([0940b4d](https://github.com/xiaoxinghu/justfiles/commit/0940b4dac43a3e36584dbcde47a654d3a6633868))
* **fs:** implement coalesceByPath ([58d8ddf](https://github.com/xiaoxinghu/justfiles/commit/58d8ddf3246576cbffd6b68549d9bb16d5c62080))
* **fs:** implement idb path-sync via the shared driver (roadmap item 2b) ([95c5b6c](https://github.com/xiaoxinghu/justfiles/commit/95c5b6c21337213ce78ec7bcd6e475225ccaa867))
* **fs:** implement inodeMetaFromSync wire decode ([f2943eb](https://github.com/xiaoxinghu/justfiles/commit/f2943eb74ae0c71043d498e04d0c9e0ff15fa81c))
* **fs:** implement journaledChangeSource.pathDeltas ([6bb04ca](https://github.com/xiaoxinghu/justfiles/commit/6bb04ca8351b3f5fc847a3a75e69693f8600776f))
* **fs:** implement journaledChangeSource.pathScan (bootstrap snapshot paging) ([2a949f8](https://github.com/xiaoxinghu/justfiles/commit/2a949f81f179d47ce5981e5a65d79e1e775e85be))
* **fs:** implement localSyncReplica.applyPathChanges ([5522984](https://github.com/xiaoxinghu/justfiles/commit/55229842004b3be5b55c5635d8908e02585e164c))
* **fs:** implement memStorage JournalStore primitive ([aeb6a41](https://github.com/xiaoxinghu/justfiles/commit/aeb6a41074ac6bff719b371ab1369ec03b7c25ac))
* **fs:** implement memStorage pathApply.applyJournaled ([431af35](https://github.com/xiaoxinghu/justfiles/commit/431af35baf32cf426191d235617d9e54421a4e20))
* **fs:** implement syncMetaFromInode wire encode ([072d7f4](https://github.com/xiaoxinghu/justfiles/commit/072d7f41439d992a89df30ebf765f191ac9040f0))
* **fs:** journal local mutations in memStorage (path-stamped, versioned) ([8b323ca](https://github.com/xiaoxinghu/justfiles/commit/8b323caea13d262a4f7b9e9839fae1625ddf8abd))
* **fs:** local-first synced() — optional remote, localFirst boot, adoption guard ([d487162](https://github.com/xiaoxinghu/justfiles/commit/d48716215a607cd6ae56fff4f09ced31bd17ef00))
* **fs:** reclaim orphaned content via out-of-band gcUnreferenced (roadmap item 4) ([fcb7d05](https://github.com/xiaoxinghu/justfiles/commit/fcb7d053d0b3f029af9b3c7a4a7134af39572bfc))
* **fs:** scaffold path-based sync (Phase 0) ([db9c89e](https://github.com/xiaoxinghu/justfiles/commit/db9c89ecaba4a73d66f6b3df2a3926201205bf99))
* **fs:** synced() negotiate, reconcileLocal, and adoption keep-local ([96219ab](https://github.com/xiaoxinghu/justfiles/commit/96219abb36871247533bdd0e8ee2cd3d4914ea71))
* **sync:** debug-gated reset shell UI + re-materialisation (step 4) ([337e477](https://github.com/xiaoxinghu/justfiles/commit/337e477d4f0e3be2a10b691cc19a8a1e13fe03da))
* **sync:** generation handshake + client-reset-on-mismatch (step 1) ([41fd18b](https://github.com/xiaoxinghu/justfiles/commit/41fd18bb52585eb95122e2bdea7b55d94807e608))
* **sync:** push fencing via x-fs-generation (step 2) ([026da7d](https://github.com/xiaoxinghu/justfiles/commit/026da7d8c7a744a0d616f719597733319de5eb4b))
* **sync:** server-coordinated volume reset endpoints (step 3) ([4207bcc](https://github.com/xiaoxinghu/justfiles/commit/4207bccae4f73452bf841ce907fd670f692244d3))


### Bug Fixes

* **fs:** avoid redundant lazy blob fetches ([2e2c804](https://github.com/xiaoxinghu/justfiles/commit/2e2c804713bbbe83232082059d56c82749d83ef4))
* **fs:** emit change events from memStorage applyJournaled ([1edbd53](https://github.com/xiaoxinghu/justfiles/commit/1edbd53d6c5496f5bffa4633fc6a93e78aa326ca))
* **fs:** never delete a directory that still has live children (RED 14) ([0a6e563](https://github.com/xiaoxinghu/justfiles/commit/0a6e5634a43628b0ad2ce3190d2c604c7523b537))
* **local-first:** bind watch on absent parent + verify appstore hashes ([62c3c50](https://github.com/xiaoxinghu/justfiles/commit/62c3c50b69b4cf44f242f5d3b71ebf7ed86779d1))
* **local-first:** bind watch on absent parent + verify appstore hashes ([c69f6a1](https://github.com/xiaoxinghu/justfiles/commit/c69f6a1537189b5d92631ed1359528a3008f6724))
* **sync:** enforce publishing lock, finalize order, take-mine crash recovery ([db09e78](https://github.com/xiaoxinghu/justfiles/commit/db09e786d85362f18cb283d803e3e3646e7a2cb9))

## [0.2.1](https://github.com/xiaoxinghu/justfiles/compare/fs-v0.2.0...fs-v0.2.1) (2026-04-30)


### Bug Fixes

* **fs:** handle stale inodes and root symlinks ([db99677](https://github.com/xiaoxinghu/justfiles/commit/db996779402cc3b5a47ca3906772c336efc92230))
* **fs:** reconcile local entries absent from remote during bootstrap ([63012cb](https://github.com/xiaoxinghu/justfiles/commit/63012cb74e173909805d4d12a3495f79b543a62f))

## [0.2.0](https://github.com/xiaoxinghu/justfiles/compare/fs-v0.1.0...fs-v0.2.0) (2026-04-10)


### Features

* fix npm release ([74c1f2b](https://github.com/xiaoxinghu/justfiles/commit/74c1f2bd43f3580e920899a3f6e18a7f6f1ec0cc))
* **fs:** add CachedStorageBackend with read-through/write-behind sync ([df7927a](https://github.com/xiaoxinghu/justfiles/commit/df7927a94ffb16e81c88f485a0f208245b067fc3))
* **fs:** add IdbStorageBackend with LRU content eviction ([a5619a8](https://github.com/xiaoxinghu/justfiles/commit/a5619a879d75630fb817ce01c483ccd36611a7e7))
* **fs:** add native local filesystem implementation ([9434307](https://github.com/xiaoxinghu/justfiles/commit/9434307b067e731698d9ad3a4e9955063846d70c))
* **fs:** add retry backoff to synced volume sync loop ([060a856](https://github.com/xiaoxinghu/justfiles/commit/060a8568c5ff6d11629ed9ba670fec56bc2062fc))
* **fs:** add scan API for efficient full-tree enumeration ([8eb25ba](https://github.com/xiaoxinghu/justfiles/commit/8eb25ba93aed4d77e88f4fb7c4dff27b4b11c14d))
* **fs:** add sqlite-backed worker filesystem ([5ba79ef](https://github.com/xiaoxinghu/justfiles/commit/5ba79ef46576c262b329bca84692ed8732676183))
* **fs:** add symlink, link, and rename to VFS interface ([d6feb66](https://github.com/xiaoxinghu/justfiles/commit/d6feb66d74b20b5fa03c33445f3386ad288a3cb6))
* **fs:** add synced volume with 2-way incremental sync ([e164fcd](https://github.com/xiaoxinghu/justfiles/commit/e164fcd7f783b6c6c72f799d7a2232d5a7c2e4fe))
* **fs:** add update streams to storage sync ([3d9eda5](https://github.com/xiaoxinghu/justfiles/commit/3d9eda55b13348058ca37f65e889d41dedaed5a5))
* **fs:** add xattr support ([ace99d7](https://github.com/xiaoxinghu/justfiles/commit/ace99d736fb2baa15680781342af10ba1c08ef05))
* **fs:** add xattr sync support and lazy content loading to synced volume ([fc1e769](https://github.com/xiaoxinghu/justfiles/commit/fc1e769ae406ca236671fe2491b169432708114c))
* **fs:** implement Volume path layer over FileSystem ([8c13fac](https://github.com/xiaoxinghu/justfiles/commit/8c13fac0077a3dcae2b85515b70a99a6275c8a23))
* **fs:** move editor assets into the filesystem ([d03e22f](https://github.com/xiaoxinghu/justfiles/commit/d03e22feba77e5fcab1e72703674dba3cf03692c))
* **fs:** optimize remote reads and harden namespace integrity ([c55276f](https://github.com/xiaoxinghu/justfiles/commit/c55276fd8fa6f6734238efbd34eb6c7bf1299140))
* **worker:** move memory editing onto cached volume ([7592903](https://github.com/xiaoxinghu/justfiles/commit/759290395b8db00f182083b850a9cb2098cb258b))


### Bug Fixes

* **fs:** add node and bun types for typecheck ([6de5f03](https://github.com/xiaoxinghu/justfiles/commit/6de5f03fc3e1f2cda371c089fe906fcbb8a267e0))
* **fs:** align workspace source resolution ([d2abec6](https://github.com/xiaoxinghu/justfiles/commit/d2abec6aa3d4646b305ff6b90d0285eb261fcfb4))
* **fs:** enforce flags and refresh cache ([75b45b9](https://github.com/xiaoxinghu/justfiles/commit/75b45b98f5a47d794c330fa4d208c11d9bd84b8a))
* **fs:** implement VFS operations ([df0edc8](https://github.com/xiaoxinghu/justfiles/commit/df0edc8ee89e9b239f35642ca61c98c8717389da))
* **fs:** persist dirty state and use backend roots ([ff4a7aa](https://github.com/xiaoxinghu/justfiles/commit/ff4a7aae5f92c6dbb848d17d971987ff98600cd5))
* **fs:** stabilize cached sync state ([a1dee6a](https://github.com/xiaoxinghu/justfiles/commit/a1dee6a2e4b023fbb6b17fba0aa0af2168d053b2))

## Changelog

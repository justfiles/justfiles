# Changelog

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

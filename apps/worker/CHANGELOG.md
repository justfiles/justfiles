# Changelog

## [0.9.0](https://github.com/xiaoxinghu/justfiles/compare/worker-v0.8.1...worker-v0.9.0) (2026-04-30)


### Features

* **ui:** share file tree view across apps ([2b5e34e](https://github.com/xiaoxinghu/justfiles/commit/2b5e34e453bd53073bb462bf66ba4e7d8443f950))


### Bug Fixes

* align react and react-dom versions to 19.2.5 ([9316504](https://github.com/xiaoxinghu/justfiles/commit/93165041c18e4799516d410653787cea8cb4a2d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 0.2.1

## [0.8.1](https://github.com/xiaoxinghu/justfiles/compare/worker-v0.8.0...worker-v0.8.1) (2026-04-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 0.2.0

## [0.8.0](https://github.com/xiaoxinghu/justfiles/compare/worker-v0.7.0...worker-v0.8.0) (2026-04-10)


### Features

* **cli:** support remote volumes ([ebd5147](https://github.com/xiaoxinghu/justfiles/commit/ebd51474d1a37e73df0571739aa94d6d759c5321))
* **fs:** optimize remote reads and harden namespace integrity ([c55276f](https://github.com/xiaoxinghu/justfiles/commit/c55276fd8fa6f6734238efbd34eb6c7bf1299140))
* **worker:** auto-focus and select file name input on new file creation ([2ca87f7](https://github.com/xiaoxinghu/justfiles/commit/2ca87f79f3ed0245f780555fac3f334c3c0ba55c))


### Bug Fixes

* **worker:** focus editor after filename submit ([a062ec1](https://github.com/xiaoxinghu/justfiles/commit/a062ec1fac27bab97db39823266976cfb5383d6c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 1.1.0

## [0.7.0](https://github.com/xiaoxinghu/justfiles/compare/worker-v0.6.0...worker-v0.7.0) (2026-04-10)


### Features

* **worker:** add scratch buffer flow ([064e6c3](https://github.com/xiaoxinghu/justfiles/commit/064e6c3f3edbbc54b809142c9ade034f9c654479))


### Bug Fixes

* **editor:** remove gutter insert control ([f2fccf0](https://github.com/xiaoxinghu/justfiles/commit/f2fccf0a0c3bb3d2640ea90e72b3e7b714c6f31c))
* **worker:** hide hidden volume entries ([42d93db](https://github.com/xiaoxinghu/justfiles/commit/42d93db6adc0dc943002350bb664c118073b630f))
* **worker:** use folder icon for organize action ([9ee5355](https://github.com/xiaoxinghu/justfiles/commit/9ee5355feedc234b601f6c83f7e8e870ef07df51))

## [0.6.0](https://github.com/xiaoxinghu/justfiles/compare/worker-v0.5.0...worker-v0.6.0) (2026-04-09)


### Features

* **worker:** show app version in settings ([e731cba](https://github.com/xiaoxinghu/justfiles/commit/e731cba30b78a6626f422c1aff26fb5bdd85b15a))

## [0.5.0](https://github.com/xiaoxinghu/justfiles/compare/worker-v0.4.0...worker-v0.5.0) (2026-04-09)


### Features

* **cli:** redesign files CLI around volumes ([501c6a9](https://github.com/xiaoxinghu/justfiles/commit/501c6a9c60c2a7124a222af7b294ba42ada326f3))
* **editor:** add gutter + insert menu for images, drawings, dividers, and tables ([2f3f476](https://github.com/xiaoxinghu/justfiles/commit/2f3f47687ef7f44e3d730aa54fc85ddccaf2de14))
* **fs:** add ApiStorageBackend wrapping the ghostore REST API ([1a9238e](https://github.com/xiaoxinghu/justfiles/commit/1a9238ef429afc02014814e389da53582bba28b6))
* **fs:** add CachedStorageBackend with read-through/write-behind sync ([df7927a](https://github.com/xiaoxinghu/justfiles/commit/df7927a94ffb16e81c88f485a0f208245b067fc3))
* **fs:** add sqlite-backed worker filesystem ([5ba79ef](https://github.com/xiaoxinghu/justfiles/commit/5ba79ef46576c262b329bca84692ed8732676183))
* **fs:** add update streams to storage sync ([3d9eda5](https://github.com/xiaoxinghu/justfiles/commit/3d9eda55b13348058ca37f65e889d41dedaed5a5))
* **fs:** add xattr sync support and lazy content loading to synced volume ([fc1e769](https://github.com/xiaoxinghu/justfiles/commit/fc1e769ae406ca236671fe2491b169432708114c))
* **fs:** move editor assets into the filesystem ([d03e22f](https://github.com/xiaoxinghu/justfiles/commit/d03e22feba77e5fcab1e72703674dba3cf03692c))
* **fs:** support rename and remove for virtual directory trees ([deec840](https://github.com/xiaoxinghu/justfiles/commit/deec840d7f26aaf2ff76df9df921ea6c1e1ef995))
* **worker:** add local fuzzy path search ([39b5864](https://github.com/xiaoxinghu/justfiles/commit/39b586486c1d3d9dfde4f10232f8dec3cfe09e3d))
* **worker:** add responsive files navigation UI ([b2318cb](https://github.com/xiaoxinghu/justfiles/commit/b2318cb1fa44918b3cc514e226717490d328946e))
* **worker:** add sidebar drag and drop note moves ([e120f85](https://github.com/xiaoxinghu/justfiles/commit/e120f8539a7a035b679422e85fa5deea010c03c0))
* **worker:** cut over deployment to justfiles ([8bbe202](https://github.com/xiaoxinghu/justfiles/commit/8bbe202aba6ebb4fccdf56016bd59542f4c1261c))
* **worker:** move memory editing onto cached volume ([7592903](https://github.com/xiaoxinghu/justfiles/commit/759290395b8db00f182083b850a9cb2098cb258b))
* **worker:** use filename-based note editing ([ae3c147](https://github.com/xiaoxinghu/justfiles/commit/ae3c1472037769266f512475d863c1148b2547fa))


### Bug Fixes

* **editor:** fall back to remoteVolume stat for freshly uploaded assets ([9901379](https://github.com/xiaoxinghu/justfiles/commit/9901379acd17189a51985b7a42bf5484f93dd0e3))
* **fs:** align workspace source resolution ([d2abec6](https://github.com/xiaoxinghu/justfiles/commit/d2abec6aa3d4646b305ff6b90d0285eb261fcfb4))
* **fs:** stabilize cached sync state ([a1dee6a](https://github.com/xiaoxinghu/justfiles/commit/a1dee6a2e4b023fbb6b17fba0aa0af2168d053b2))
* **worker:** align notes layout backgrounds ([ec25ea4](https://github.com/xiaoxinghu/justfiles/commit/ec25ea42b67a8c73063ff278efad50df0f5badd0))
* **worker:** dedupe file header actions by layout ([c315bd9](https://github.com/xiaoxinghu/justfiles/commit/c315bd92fe4cd5d527c96ea33dd5e7f7747f620a))
* **worker:** support nested note renames ([b0ce90e](https://github.com/xiaoxinghu/justfiles/commit/b0ce90e3b39296b2b9d1e87e06f659bbb0c83c93))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 1.0.0

## [0.4.0](https://github.com/xiaoxinghu/ghostore/compare/worker-v0.3.2...worker-v0.4.0) (2026-03-29)


### Features

* **pwa:** add bullet list input rule and Enter key handling in editor ([eb74afe](https://github.com/xiaoxinghu/ghostore/commit/eb74afe6ee6b40edc8de568842f75f2afa997115))
* **pwa:** add excalidraw drawing canvas node to editor ([740b387](https://github.com/xiaoxinghu/ghostore/commit/740b387d57167e5b5f0d953989c34d972fd9b8fd))


### Bug Fixes

* **editor:** move drawing modal out of node view ([761084c](https://github.com/xiaoxinghu/ghostore/commit/761084c1ca8d7e348eebfeac8be905f4e0dc5f01))
* **worker:** add ASSETS R2 bucket binding to dev environment ([01af8ac](https://github.com/xiaoxinghu/ghostore/commit/01af8ac569edd60948bb3f7f29753812614469f9))

## [0.3.2](https://github.com/xiaoxinghu/ghostore/compare/worker-v0.3.1...worker-v0.3.2) (2026-03-28)


### Bug Fixes

* **pwa:** fix landing page style ([79630b2](https://github.com/xiaoxinghu/ghostore/commit/79630b2b4433257a4e756f5f77deba61b1427b3f))
* **pwa:** prevent iOS keyboard toolbar from scrolling fixed UI elements ([0951dbe](https://github.com/xiaoxinghu/ghostore/commit/0951dbe3387dba2174f7e8e93cb3b490f034e998))

## [0.3.1](https://github.com/xiaoxinghu/ghostore/compare/worker-v0.3.0...worker-v0.3.1) (2026-03-27)


### Bug Fixes

* **pwa:** prevent iOS keyboard toolbar from scrolling app shell layout ([b326127](https://github.com/xiaoxinghu/ghostore/commit/b326127de9de31b1e59199a360e68b971fc70dbf))

## [0.3.0](https://github.com/xiaoxinghu/ghostore/compare/worker-v0.2.0...worker-v0.3.0) (2026-03-27)


### Features

* **pwa:** add landing page for unauthenticated users ([2d2763a](https://github.com/xiaoxinghu/ghostore/commit/2d2763ae23ae7d97f126d162507b7e860831ae64))
* **search:** enrich debug output with expansion, routing, sources, and rrf rank ([dd7dbf7](https://github.com/xiaoxinghu/ghostore/commit/dd7dbf7d6821524c45df4636b86a53312daed449))


### Bug Fixes

* **pwa:** improve mobile layout stability and editor fill behaviour ([150909d](https://github.com/xiaoxinghu/ghostore/commit/150909de90404e24f6ee3584fd881fb939eb3e16))

## [0.2.0](https://github.com/xiaoxinghu/ghostore/compare/worker-v0.1.1...worker-v0.2.0) (2026-03-26)


### Features

* **search:** use lex variant for FTS and add HyDE for semantic search ([8a492be](https://github.com/xiaoxinghu/ghostore/commit/8a492be36aa8bcddd59fdc328b02a63cae98dc21))

## [0.1.1](https://github.com/xiaoxinghu/ghostore/compare/worker-v0.1.0...worker-v0.1.1) (2026-03-26)


### Bug Fixes

* **search:** stabilize hybrid search scoring ([b0a208c](https://github.com/xiaoxinghu/ghostore/commit/b0a208ce5c2b6444370223ad55365b150bbc2257))

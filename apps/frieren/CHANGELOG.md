# Changelog

## [0.3.1](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.3.0...spud-v0.3.1) (2026-07-17)


### Bug Fixes

* **frieren:** move capability WS auth off the URL query string ([893b0d3](https://github.com/xiaoxinghu/justfiles/commit/893b0d36bdc9acb18e48d801261f371d1f686c69)), closes [#135](https://github.com/xiaoxinghu/justfiles/issues/135)
* **frieren:** only echo the caps subprotocol when the client offered it ([e51ba44](https://github.com/xiaoxinghu/justfiles/commit/e51ba448b87c0059664e2f336cc3fb0b02d8869a))
* **frieren:** stop desktop drag from starting native text selection ([7cea04b](https://github.com/xiaoxinghu/justfiles/commit/7cea04b25331ea2c42149035ac908165b0412ca2))

## [0.3.0](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.2.0...spud-v0.3.0) (2026-07-17)


### Features

* **frieren:** App Store tile in the omnibar grid for store discovery ([04e4795](https://github.com/xiaoxinghu/justfiles/commit/04e4795b9a4b94fa26cb4f6d77d4b85b875e03f2))
* **frieren:** custom desktop wallpaper from the volume ([a663a6c](https://github.com/xiaoxinghu/justfiles/commit/a663a6cadbbf3bd763381bc59cf1bc03bf7e9f84))
* **frieren:** local→account migration core (fs.ts) ([64fa430](https://github.com/xiaoxinghu/justfiles/commit/64fa43015f3d006b9a1b5ce59e7eb9c6de0234cc))
* **frieren:** surface local→account migration offer in the omnibar ([7b7fe20](https://github.com/xiaoxinghu/justfiles/commit/7b7fe209b2428e5d2c0a785b9bba2abab0d5f4b8))


### Bug Fixes

* **frieren:** don't clobber account content added after the migration offer ([8201fb5](https://github.com/xiaoxinghu/justfiles/commit/8201fb52e1aafe4459baffc41ca3a4c3cfe51509))
* **frieren:** target captured account on migrate; refresh identity after copy ([e9780c3](https://github.com/xiaoxinghu/justfiles/commit/e9780c3cb7fd46a0667ad15343139e6d91d42a4f))

## [0.2.0](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.1.0...spud-v0.2.0) (2026-07-16)


### Features

* **accounts:** Spud AI as the always-on default backend ([c53b468](https://github.com/xiaoxinghu/justfiles/commit/c53b4682acffedba239adb58e4eeb72952b26a5e))
* **frieren:** add agent summoning ritual ([c93d357](https://github.com/xiaoxinghu/justfiles/commit/c93d3573d2c1940ef2ef01c37ea76d1e786ecaf9))
* **frieren:** apply namespaced system layout ([1de4220](https://github.com/xiaoxinghu/justfiles/commit/1de4220da277008080725e7978da0681066eec48))
* **frieren:** clickable sync-status menu with volume resets ([285a5fc](https://github.com/xiaoxinghu/justfiles/commit/285a5fcac7fbce7f0d242fd275b5606e3c63a695))
* **frieren:** ensure built-ins are installed on every boot ([7026c70](https://github.com/xiaoxinghu/justfiles/commit/7026c70e0fda1d564e4c39d6459bde3fb84518d5))
* **frieren:** notifications Slice 1 — channel, store, pill sink, dropup center ([85ae0e0](https://github.com/xiaoxinghu/justfiles/commit/85ae0e0c68a39e77bd58fbec7c04514eb952834c))
* **frieren:** notifications Slice 2 — the notify capability for apps ([fee2800](https://github.com/xiaoxinghu/justfiles/commit/fee2800aeb8bcecedcdb339059ab2f49c36f0aaf))
* **frieren:** ship app-notes as a built-in ([d8b1148](https://github.com/xiaoxinghu/justfiles/commit/d8b11481eb6728fea42aae56bc0050bce5f6351e))
* **settings:** add Spud AI provider, drop fastmail ([69cb0da](https://github.com/xiaoxinghu/justfiles/commit/69cb0daea995ba04c47d7a09f08970ef3de3e8b7))
* **user:** add a user capability and show the signed-in user in Settings ([5207631](https://github.com/xiaoxinghu/justfiles/commit/52076313db6480cdd872133600dead86965dfdc7))


### Bug Fixes

* **app-files:** end permanent "Loading…" via runtime scan coalescing ([d027555](https://github.com/xiaoxinghu/justfiles/commit/d0275550361f884f1262889ff037dc138b976f56))
* **frieren:** don't run notification side effects inside a setState updater ([63d2d14](https://github.com/xiaoxinghu/justfiles/commit/63d2d145b329ece305aff727024744d06f26869e))
* **frieren:** gate kernel getToken/getUser on Clerk readiness ([780835e](https://github.com/xiaoxinghu/justfiles/commit/780835eed06c374e4158356f7b5ec348a808acfa))
* **frieren:** keep omnibar presence glow to the border ring ([17d344f](https://github.com/xiaoxinghu/justfiles/commit/17d344fd9d5a50b21c474e86ceab86caa30f29b1))
* **frieren:** ritual fits the viewport, responds, and wears the bound face ([45ff817](https://github.com/xiaoxinghu/justfiles/commit/45ff8179e7f0c16829a87d469503fd8c57d17cf0))
* **frieren:** surface the no-AI turn failure in the chat ([610da29](https://github.com/xiaoxinghu/justfiles/commit/610da29f0ef7ea7562dd7a721d4836047661b4fa))
* **pwa:** prompt-based updates + periodic detection ([8ddac3a](https://github.com/xiaoxinghu/justfiles/commit/8ddac3a9fcd2809100c77f5041d8990a5cf3af10))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 0.3.0

## [1.1.0](https://github.com/xiaoxinghu/justfiles/compare/frieren-v1.0.2...frieren-v1.1.0) (2026-05-01)


### Features

* add app launcher with icons ([2ce60be](https://github.com/xiaoxinghu/justfiles/commit/2ce60be553a6c679666433c55b77a0daa2b52e40))
* **app-doom:** add browser doom app ([75d6c79](https://github.com/xiaoxinghu/justfiles/commit/75d6c79cc6be395059705d909c2351c59119ec2f))
* stream app assets via static-assets binding ([2078dbc](https://github.com/xiaoxinghu/justfiles/commit/2078dbcfe7d29e56109694ee59a47337d6e4f4d6))

## [1.0.2](https://github.com/xiaoxinghu/justfiles/compare/frieren-v1.0.1...frieren-v1.0.2) (2026-04-30)


### Bug Fixes

* **frieren:** use justbuddy clerk key ([e3039b7](https://github.com/xiaoxinghu/justfiles/commit/e3039b75d5575cb821665265071064a54c4e7064))

## [1.0.1](https://github.com/xiaoxinghu/justfiles/compare/frieren-v1.0.0...frieren-v1.0.1) (2026-04-30)


### Bug Fixes

* **frieren:** configure justbuddy domain ([728449b](https://github.com/xiaoxinghu/justfiles/commit/728449bf84da6de01c3be45501fe14aadf9bac24))

## 1.0.0 (2026-04-30)


### ⚠ BREAKING CHANGES

* **app:** move narrate from agent to per-transition
* **app:** remodel engine as state machine

### Features

* **app:** extract @justfiles/app package + Vite-driven app format ([550e124](https://github.com/xiaoxinghu/justfiles/commit/550e1243216ab39e0abf20ec3dfcbde81f0c029b))
* **app:** move narrate from agent to per-transition ([b7594d0](https://github.com/xiaoxinghu/justfiles/commit/b7594d028041a25b9be28a82425d6ea44631baa8))
* **app:** remodel engine as state machine ([62e081a](https://github.com/xiaoxinghu/justfiles/commit/62e081ad88a2082a2a8b2ef36a116bb527d25ace))
* **crossword:** add printable clue view ([d421247](https://github.com/xiaoxinghu/justfiles/commit/d421247e25425b0aa6232d2be18faa55c7d5dc33))
* **frieren:** add app state json toggle ([0e17b78](https://github.com/xiaoxinghu/justfiles/commit/0e17b7849f68081c319487d10084c8fd617b5b44))
* **frieren:** add Clerk auth and nuke endpoint ([b2247b8](https://github.com/xiaoxinghu/justfiles/commit/b2247b8ffa40236a7a8f725c39dbe645f07e3cad))
* **frieren:** add embeddable app runtime with card and counter samples ([2c2d51c](https://github.com/xiaoxinghu/justfiles/commit/2c2d51c9b2cfc65a880ce1a08e0c3191d0195b7f))
* **frieren:** add file preview copy action ([1644375](https://github.com/xiaoxinghu/justfiles/commit/1644375e1262d9133878cee3f66e2229c983a14c))
* **frieren:** add JRPG chat view with roaming avatar ([94e29a4](https://github.com/xiaoxinghu/justfiles/commit/94e29a499692b16c35eec61d96cd13996d562bca))
* **frieren:** add Phase 1 chat with streaming LLM via Durable Object WebSocket ([0b1f7f0](https://github.com/xiaoxinghu/justfiles/commit/0b1f7f0c4ced7653360f6972c7efb03f2baad91e))
* **frieren:** add Phase 2 persistent memory via SQLite-backed virtual filesystem ([ea5d1ec](https://github.com/xiaoxinghu/justfiles/commit/ea5d1ec6b42595c892dd6bd87d048dd8c6a64b8e))
* **frieren:** add rolling session summaries ([7080eb0](https://github.com/xiaoxinghu/justfiles/commit/7080eb0cd95b6c9e5a7e7ec1393bf8dd4a83fc8c))
* **frieren:** add shadcn chat style ([f35e8f5](https://github.com/xiaoxinghu/justfiles/commit/f35e8f5eee0e4ba0a44b79b1d809375a33ca4b57))
* **frieren:** add structured onboarding flow with user profile and agent soul setup ([d6db11e](https://github.com/xiaoxinghu/justfiles/commit/d6db11e8116412432be4dbe1ebadf5d3d0226fa3))
* **frieren:** add tamagotchi skin bundles ([6e42399](https://github.com/xiaoxinghu/justfiles/commit/6e423995e575069304b75c5e51794214bb464af3))
* **frieren:** add token-budget session retention ([5fe0edc](https://github.com/xiaoxinghu/justfiles/commit/5fe0edcf64920bf9b9c799a725cf4134c76648d3))
* **frieren:** add web fetch tool via readable.page ([06af5bc](https://github.com/xiaoxinghu/justfiles/commit/06af5bc2cad49ea2af64e4936fb211d9c5724998))
* **frieren:** add web search tool via duckduckgo ([ece9702](https://github.com/xiaoxinghu/justfiles/commit/ece9702b98e6efc7bab8e38318505fa3c6c2c178))
* **frieren:** consolidate daily notes into permanent memory ([3df26c6](https://github.com/xiaoxinghu/justfiles/commit/3df26c61934ffcdf0f1c3f86f19fa7860bd1f658))
* **frieren:** derive typed app tools and persist session logs ([ecdda4b](https://github.com/xiaoxinghu/justfiles/commit/ecdda4bd1d6420ba24a3fc717012a8c4430c35a8))
* **frieren:** dynamic system prompt with profile memory and local LLM backend ([5702445](https://github.com/xiaoxinghu/justfiles/commit/57024454cee3bcddc7a23b98fb81fe808636fefc))
* **frieren:** extract memory inbox on session close ([936bd99](https://github.com/xiaoxinghu/justfiles/commit/936bd9996597b653fde7d86c9f296b2b016e525f))
* **frieren:** implement session state machine and transcript writer (phase 1) ([30ad4b2](https://github.com/xiaoxinghu/justfiles/commit/30ad4b23cf07f5f33e3b3f8b9a0bd27a4cf13fd3))
* **frieren:** include recent daily notes in system prompt ([e585da8](https://github.com/xiaoxinghu/justfiles/commit/e585da8fbdd34ac83ed862a1045edd6ec551a582))
* **frieren:** inject age-band communication calibration into system prompt ([0e24240](https://github.com/xiaoxinghu/justfiles/commit/0e2424026b0eff27fdee9114b64c82e983fa08c8))
* **frieren:** load session prompt from /soul.md ([b755158](https://github.com/xiaoxinghu/justfiles/commit/b7551582d89b429d783cc9f439a9b08f676fe554))
* **frieren:** migrate onboarding to shadcn ([3333d41](https://github.com/xiaoxinghu/justfiles/commit/3333d410fd99eece0b6086ff19645a49bc2d994d))
* **frieren:** redesign onboarding archetype selector ([56ca476](https://github.com/xiaoxinghu/justfiles/commit/56ca476a4cb0601dca7c098622ba503bafcd0b5e))
* **frieren:** reflect notes via global jsonl with read-before-write guard ([42d3106](https://github.com/xiaoxinghu/justfiles/commit/42d3106fc7be30e6e74e132ec950e7048889caf4))
* **frieren:** split shadcn view into two-column JRPG layout ([3ebbfb2](https://github.com/xiaoxinghu/justfiles/commit/3ebbfb2481991ee03368a9b202054434f4608ed1))
* **frieren:** wire session manager into WebSocket lifecycle ([65978dc](https://github.com/xiaoxinghu/justfiles/commit/65978dcd37b22f5d38655f2afdab41e6c5dce62f))
* **ui:** share file tree view across apps ([2b5e34e](https://github.com/xiaoxinghu/justfiles/commit/2b5e34e453bd53073bb462bf66ba4e7d8443f950))


### Bug Fixes

* align react and react-dom versions to 19.2.5 ([9316504](https://github.com/xiaoxinghu/justfiles/commit/93165041c18e4799516d410653787cea8cb4a2d6))
* **frieren:** configure app loader deployments ([b48b1cc](https://github.com/xiaoxinghu/justfiles/commit/b48b1cc1365a7ee1ba262fd7a975154b81a57348))
* **frieren:** handle thinking-only assistant turns ([027dd2f](https://github.com/xiaoxinghu/justfiles/commit/027dd2f84408a6e3fe00f2aa3bbd8cb0ac6a1be5))
* **frieren:** improve chat tool rendering ([8ebf026](https://github.com/xiaoxinghu/justfiles/commit/8ebf026bc22d26f0fa6cc0ff1b86e69141272364))
* **frieren:** match shadcn input background to chat box ([2e7ee62](https://github.com/xiaoxinghu/justfiles/commit/2e7ee62ef93987587accfd7007d002aca012982b))
* **frieren:** remove deprecated tsconfig baseUrl ([ea91fd5](https://github.com/xiaoxinghu/justfiles/commit/ea91fd54ded7c4b6ede4ece14c8022fccee4642e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 0.2.1

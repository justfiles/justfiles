# Changelog

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

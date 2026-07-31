# Changelog

## [0.10.0](https://github.com/xiaoxinghu/justfiles/compare/frieren-v0.9.0...frieren-v0.10.0) (2026-07-31)


### Features

* **accounts:** AccountInfo.origin — Settings shows which host owns an account ([#317](https://github.com/xiaoxinghu/justfiles/issues/317)) ([f126c16](https://github.com/xiaoxinghu/justfiles/commit/f126c1684235179e2678719142ab0c7e6be47306))
* **accounts:** seal the creds lane at rest with a key the volume never holds ([#309](https://github.com/xiaoxinghu/justfiles/issues/309)) ([99470a7](https://github.com/xiaoxinghu/justfiles/commit/99470a76e7b2000ec1cdeda2fc8dc52565191b1b))
* **agent:** expression channel — per-sentence tags drive the avatar face ([b56ffb9](https://github.com/xiaoxinghu/justfiles/commit/b56ffb9eecc7e1b498d31e707556c524e9c27293))
* **agent:** lazily derive per-expression faces from the user's avatar ([65b4ff8](https://github.com/xiaoxinghu/justfiles/commit/65b4ff807b2c5710ab0e6c3089f448697f9b36df))
* **agent:** pace a reply's expression tags instead of showing only the last ([c402e59](https://github.com/xiaoxinghu/justfiles/commit/c402e59e3c982508971b3faab4df59c8676f11d9))
* **agent:** teach the agent its filesystem, and deny it the secrets ([160cbb1](https://github.com/xiaoxinghu/justfiles/commit/160cbb10a6eed3241bd3c757f240038bcb6c5dd8))
* **frieren:** a built-in face set per archetype, and an expression channel that holds ([#316](https://github.com/xiaoxinghu/justfiles/issues/316)) ([fd1d888](https://github.com/xiaoxinghu/justfiles/commit/fd1d888f73921fa26e2117d227b7dad422103e0b))
* **frieren:** dev-only readout of the current expression ([b1971b4](https://github.com/xiaoxinghu/justfiles/commit/b1971b44aa6c42c1b1351bb121b263fb175f29e4))
* **frieren:** the omnibar's face travels from pill chip to shoulder ([3f620b3](https://github.com/xiaoxinghu/justfiles/commit/3f620b30b6fd03feeaee63c4b197fc94e8627e7a))
* **frieren:** the resting pill is one line; nothing opens the chat window ([f29f847](https://github.com/xiaoxinghu/justfiles/commit/f29f8479efdde17360e80c4f15e3969a744d1dd2))
* **fs,app:** a /private root — credentials never replicate ([#307](https://github.com/xiaoxinghu/justfiles/issues/307)) ([65a42f5](https://github.com/xiaoxinghu/justfiles/commit/65a42f50db54e128fe1c781a76429d380c7056ac)), closes [#291](https://github.com/xiaoxinghu/justfiles/issues/291)


### Bug Fixes

* **accounts:** the built-in AI is the floor — it can be taken over, never switched off ([#315](https://github.com/xiaoxinghu/justfiles/issues/315)) ([c393a7e](https://github.com/xiaoxinghu/justfiles/commit/c393a7e7cadec0e4e8bf202d8845fccfd6ff6442))
* **agent:** a face belongs to its turn, and only a host that asked gets stripped ([9832e0e](https://github.com/xiaoxinghu/justfiles/commit/9832e0e76261c49108069d2067a65686ec90c4ee))
* **agent:** a tag only counts where a sentence opens, and a face can be retried ([630b3ad](https://github.com/xiaoxinghu/justfiles/commit/630b3ad5c449b7c25997c3fbed3573500d014842))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 0.5.0

## [0.9.0](https://github.com/xiaoxinghu/justfiles/compare/frieren-v0.8.0...frieren-v0.9.0) (2026-07-26)


### Features

* **design:** add the --danger token and collapse seven copies of it ([c1675cb](https://github.com/xiaoxinghu/justfiles/commit/c1675cbb40106f71ab7e138f4032a8841d236188))
* **dictionary:** learning-aware dictionary app as a Frieren built-in ([180768b](https://github.com/xiaoxinghu/justfiles/commit/180768b136a096ead7456bccbb088b6c8c6cad2b))
* purpose-scoped learning context projection for ai capability ([a5b26a9](https://github.com/xiaoxinghu/justfiles/commit/a5b26a948b055e47df6ed5cc014d74e32c941d4c))


### Bug Fixes

* authorize scoped capabilities against the executing bundle ([e58cca4](https://github.com/xiaoxinghu/justfiles/commit/e58cca4178634355547c507efe07d59999cad5ea))
* build every built-in before frieren dev, and keep the field on the live word ([9b1482e](https://github.com/xiaoxinghu/justfiles/commit/9b1482e60f5e8139975b5c29b733d0743d5dec67))
* re-resolve trusted scopes on the worker; key learning single-flight by source ([fefe3bf](https://github.com/xiaoxinghu/justfiles/commit/fefe3bf14d83cdc8d9585a3e561d93c9853653bb))

## [0.8.0](https://github.com/xiaoxinghu/justfiles/compare/frieren-v0.7.0...frieren-v0.8.0) (2026-07-25)


### Features

* **accounts:** Spud AI as the always-on default backend ([c53b468](https://github.com/xiaoxinghu/justfiles/commit/c53b4682acffedba239adb58e4eeb72952b26a5e))
* **accounts:** unify email/calendar onto the accounts use/admin pattern ([58173e6](https://github.com/xiaoxinghu/justfiles/commit/58173e66385c4b84c8dfe03867e4400b6f2a572e))
* **agent,app,frieren:** capability-provided agent tools (Step 3.5), image first ([310f918](https://github.com/xiaoxinghu/justfiles/commit/310f918fc738d954717881233cc753dd73a27d62))
* **agent,ui,frieren:** render generated images inline in the transcript ([#194](https://github.com/xiaoxinghu/justfiles/issues/194)) ([b82f5a7](https://github.com/xiaoxinghu/justfiles/commit/b82f5a705e892cac1d4cad9f5712f92afc8a29be))
* **app-code:** state built-in-SDK-only contract; retire frieren baked runtime ([62b407f](https://github.com/xiaoxinghu/justfiles/commit/62b407fba04ffad509d9315340d4b7084bd4cebb))
* **app-files:** auto-refresh the file tree on volume changes ([256dcdc](https://github.com/xiaoxinghu/justfiles/commit/256dcdcad0347e0e36769b1331dfc20a6963f56c))
* **app,frieren:** add the image capability, backed by Spud over OpenRouter ([07b7112](https://github.com/xiaoxinghu/justfiles/commit/07b71129d5935430624cdc8878d10fdab85c790a))
* **app:** derive agent tools from self-describing capability contracts ([95b03fe](https://github.com/xiaoxinghu/justfiles/commit/95b03fe823419f4b5fa3f2aa4cf127731d0a1d40))
* **app:** kernel catalog lifecycle events + hidden-id convention ([3f0de5f](https://github.com/xiaoxinghu/justfiles/commit/3f0de5fd3733cde47a32df56419b0e7744baa686))
* **app:** make devkit toolchain resolution caller-aware by app id ([17e9d0b](https://github.com/xiaoxinghu/justfiles/commit/17e9d0b9561db066a2884e4a56274632d5dbf6a0))
* **app:** resolve reducer SDK sentinel at spawn via es-module-lexer ([897ed75](https://github.com/xiaoxinghu/justfiles/commit/897ed755526408bc7b940a050b2332f85edf97e7))
* **app:** serve host SDK as vendor modules via shared externals constant ([a186b4a](https://github.com/xiaoxinghu/justfiles/commit/a186b4ac6758484ccc21897bd4db8cb6c61f8181))
* **devkit:** select compile backend via #engine (esbuild/Bun.build) ([43e5a33](https://github.com/xiaoxinghu/justfiles/commit/43e5a33d3ecc4e891be132b74e433decbdf041ef))
* **frieren:** add agent summoning ritual ([c93d357](https://github.com/xiaoxinghu/justfiles/commit/c93d3573d2c1940ef2ef01c37ea76d1e786ecaf9))
* **frieren:** agent reaches email/calendar via use-facet capabilities ([c2f797c](https://github.com/xiaoxinghu/justfiles/commit/c2f797cb2c2e8388e53b85d4603392d97adaf127))
* **frieren:** App Store tile in the omnibar grid for store discovery ([04e4795](https://github.com/xiaoxinghu/justfiles/commit/04e4795b9a4b94fa26cb4f6d77d4b85b875e03f2))
* **frieren:** apply namespaced system layout ([1de4220](https://github.com/xiaoxinghu/justfiles/commit/1de4220da277008080725e7978da0681066eec48))
* **frieren:** brand icon.png as PWA icon, favicon, and agent avatar ([#265](https://github.com/xiaoxinghu/justfiles/issues/265)) ([f398922](https://github.com/xiaoxinghu/justfiles/commit/f3989220040f3a2711a84b9757eab48126eff141))
* **frieren:** clickable sync-status menu with volume resets ([285a5fc](https://github.com/xiaoxinghu/justfiles/commit/285a5fcac7fbce7f0d242fd275b5606e3c63a695))
* **frieren:** custom desktop wallpaper from the volume ([a663a6c](https://github.com/xiaoxinghu/justfiles/commit/a663a6cadbbf3bd763381bc59cf1bc03bf7e9f84))
* **frieren:** cut accounts storage to the Volume; retire the creds CLI path ([e1a2588](https://github.com/xiaoxinghu/justfiles/commit/e1a25883f60676117bde1c098c605c1327545089))
* **frieren:** dev-only app sideload via FRIEREN_DEV_APPS ([#224](https://github.com/xiaoxinghu/justfiles/issues/224)) ([42c36b8](https://github.com/xiaoxinghu/justfiles/commit/42c36b83ceced3b3ed6e13c16da90a0df881519a))
* **frieren:** dual-window AI caps (rolling 5h burst + fixed weekly) ([13756a6](https://github.com/xiaoxinghu/justfiles/commit/13756a6be456b600f0058db9f57b72ad3334a4d5))
* **frieren:** ensure built-ins are installed on every boot ([7026c70](https://github.com/xiaoxinghu/justfiles/commit/7026c70e0fda1d564e4c39d6459bde3fb84518d5))
* **frieren:** finish the omnibar sheet — capped tail + conversation access ([fdbfc9d](https://github.com/xiaoxinghu/justfiles/commit/fdbfc9d19d36d499451b2563c5f8c71d70f8d88a))
* **frieren:** lift the platform AI cap in local dev only ([a405986](https://github.com/xiaoxinghu/justfiles/commit/a405986192c35dc8223314592ef5d8910554d35b))
* **frieren:** local→account migration core (fs.ts) ([64fa430](https://github.com/xiaoxinghu/justfiles/commit/64fa43015f3d006b9a1b5ce59e7eb9c6de0234cc))
* **frieren:** move the Spud AI backend from OpenAI to OpenRouter ([88f7f62](https://github.com/xiaoxinghu/justfiles/commit/88f7f62ad0e38a09bbdaf026587bfa9653f2004d))
* **frieren:** notifications Slice 1 — channel, store, pill sink, dropup center ([85ae0e0](https://github.com/xiaoxinghu/justfiles/commit/85ae0e0c68a39e77bd58fbec7c04514eb952834c))
* **frieren:** notifications Slice 2 — the notify capability for apps ([fee2800](https://github.com/xiaoxinghu/justfiles/commit/fee2800aeb8bcecedcdb339059ab2f49c36f0aaf))
* **frieren:** per-user usage metering ([#212](https://github.com/xiaoxinghu/justfiles/issues/212)) ([788b651](https://github.com/xiaoxinghu/justfiles/commit/788b651763f2137de6ed2f5076cd48e036eb41e0))
* **frieren:** presence glow and a real conversation window ([3bd4024](https://github.com/xiaoxinghu/justfiles/commit/3bd402421a26217ff6ea204fc99b172adcd5ae3a))
* **frieren:** replace the dock with the omnibar (launch ∪ ask) ([d9aba41](https://github.com/xiaoxinghu/justfiles/commit/d9aba41a64ae645606b9aee8d4da11b27dc8ed0a))
* **frieren:** run app GUIs in a sandboxed iframe ([19947ba](https://github.com/xiaoxinghu/justfiles/commit/19947ba4512617f163ccb9b19a6d1b73fb7053af))
* **frieren:** ship app-notes as a built-in ([d8b1148](https://github.com/xiaoxinghu/justfiles/commit/d8b11481eb6728fea42aae56bc0050bce5f6351e))
* **frieren:** show focused app version in menubar ([bead5e7](https://github.com/xiaoxinghu/justfiles/commit/bead5e7c0aa10e98386dadcd519d4a57e8fde61e))
* **frieren:** surface local→account migration offer in the omnibar ([7b7fe20](https://github.com/xiaoxinghu/justfiles/commit/7b7fe209b2428e5d2c0a785b9bba2abab0d5f4b8))
* **frieren:** usage caps + tiers (free/pro) with AI pre-turn enforcement ([1c2ee2d](https://github.com/xiaoxinghu/justfiles/commit/1c2ee2db8ac7dde616b978f6d787dac9db073cf4))
* **fs:** proactive, fs-level sync driven by the volume change feed ([29f4cb0](https://github.com/xiaoxinghu/justfiles/commit/29f4cb08dfc8afe0686c8de7214effb22a9c651e))
* **kodama:** one-off migrateAppIdsV1 migrator + Frieren RPC ([e0fe630](https://github.com/xiaoxinghu/justfiles/commit/e0fe630e008355f80bb3c10c34280e718404735f))
* **kodama:** rebrand user-facing copy (AI provider name, page title) ([1df282c](https://github.com/xiaoxinghu/justfiles/commit/1df282cd668b31a0662c39e2ed32fe8562f35d79))
* **kodama:** run the id migration automatically on login, before seed ([0f9d79e](https://github.com/xiaoxinghu/justfiles/commit/0f9d79e2652a5d3c2f592bbe61511e629f08b2b9))
* **settings:** add Spud AI provider, drop fastmail ([69cb0da](https://github.com/xiaoxinghu/justfiles/commit/69cb0daea995ba04c47d7a09f08970ef3de3e8b7))
* **settings:** Usage panel — AI + storage against plan ([a76942b](https://github.com/xiaoxinghu/justfiles/commit/a76942b1a2fc955d806b28e275257189c0232e15))
* **sync:** debug-gated reset shell UI + re-materialisation (step 4) ([337e477](https://github.com/xiaoxinghu/justfiles/commit/337e477d4f0e3be2a10b691cc19a8a1e13fe03da))
* **sync:** push fencing via x-fs-generation (step 2) ([026da7d](https://github.com/xiaoxinghu/justfiles/commit/026da7d8c7a744a0d616f719597733319de5eb4b))
* **sync:** server-coordinated volume reset endpoints (step 3) ([4207bcc](https://github.com/xiaoxinghu/justfiles/commit/4207bccae4f73452bf841ce907fd670f692244d3))
* **user:** add a user capability and show the signed-in user in Settings ([5207631](https://github.com/xiaoxinghu/justfiles/commit/52076313db6480cdd872133600dead86965dfdc7))


### Bug Fixes

* **app-files:** end permanent "Loading…" via runtime scan coalescing ([d027555](https://github.com/xiaoxinghu/justfiles/commit/d0275550361f884f1262889ff037dc138b976f56))
* **app:** reflect synced-down agent edits in the open GUI ([#226](https://github.com/xiaoxinghu/justfiles/issues/226)) ([e5b2109](https://github.com/xiaoxinghu/justfiles/commit/e5b210910777e822eeda098ff0f7446fe3146651))
* **frieren,ui:** address image-resolver review findings ([114e36c](https://github.com/xiaoxinghu/justfiles/commit/114e36c115f9c6f96c2ad11a6419c860139b33d0))
* **frieren:** address Codex review on composers ([47f3b51](https://github.com/xiaoxinghu/justfiles/commit/47f3b5105048682737521c873b77ef23c2348fd7))
* **frieren:** allow forms in the app sandbox ([44e4aa3](https://github.com/xiaoxinghu/justfiles/commit/44e4aa361e3b176a8beb8d0f4c97c449aae55b5e))
* **frieren:** auto-grow omnibar + chat composers like iMessage ([2570921](https://github.com/xiaoxinghu/justfiles/commit/25709210851dbf33cb119856926de16a70c5e76a))
* **frieren:** boot each sandboxed app frame exactly once per load ([9b5d3de](https://github.com/xiaoxinghu/justfiles/commit/9b5d3de698f6f2345de130aee8ba37214099222c))
* **frieren:** click anywhere in a window to focus + macOS active/inactive styling ([a128f1c](https://github.com/xiaoxinghu/justfiles/commit/a128f1ccb32c9aba9ced791f6f91377ddf94a77b))
* **frieren:** close omnibar top gap; pin chat send inside the field (iMessage) ([562172c](https://github.com/xiaoxinghu/justfiles/commit/562172c541d6c9facf954c3bdd5a568b67ed044a))
* **frieren:** convert CJS require of externalised React to ESM imports ([6433512](https://github.com/xiaoxinghu/justfiles/commit/6433512e293d6ed7cddf79edec820c2d2707cfeb))
* **frieren:** don't clobber account content added after the migration offer ([8201fb5](https://github.com/xiaoxinghu/justfiles/commit/8201fb52e1aafe4459baffc41ca3a4c3cfe51509))
* **frieren:** don't run notification side effects inside a setState updater ([63d2d14](https://github.com/xiaoxinghu/justfiles/commit/63d2d145b329ece305aff727024744d06f26869e))
* **frieren:** enforce border-box in useAutoResize so empty composers stay one line ([71997cc](https://github.com/xiaoxinghu/justfiles/commit/71997cc0d303120b5ae3c1f39aa49d536e3a7afb))
* **frieren:** Escape never closes a window ([068fe43](https://github.com/xiaoxinghu/justfiles/commit/068fe4369ef42897626b7948782f1d76b3d05f8b))
* **frieren:** exclude connection credentials from profile migration ([22e2453](https://github.com/xiaoxinghu/justfiles/commit/22e2453cdb45cd6631cdc5571ffca1039ff55602))
* **frieren:** gate kernel getToken/getUser on Clerk readiness ([780835e](https://github.com/xiaoxinghu/justfiles/commit/780835eed06c374e4158356f7b5ec348a808acfa))
* **frieren:** keep omnibar presence glow to the border ring ([17d344f](https://github.com/xiaoxinghu/justfiles/commit/17d344fd9d5a50b21c474e86ceab86caa30f29b1))
* **frieren:** keep os-state v1 readable by pre-placements clients ([d2fee46](https://github.com/xiaoxinghu/justfiles/commit/d2fee46b12c6d77f45ba89c3663b2a347016a96f))
* **frieren:** mount trusted built-ins in-realm, sandbox only untrusted apps ([cbc56f6](https://github.com/xiaoxinghu/justfiles/commit/cbc56f6599fd034bb4c28368a9a7aef57d679576))
* **frieren:** move capability WS auth off the URL query string ([893b0d3](https://github.com/xiaoxinghu/justfiles/commit/893b0d36bdc9acb18e48d801261f371d1f686c69)), closes [#135](https://github.com/xiaoxinghu/justfiles/issues/135)
* **frieren:** navigate omnibar results only at the caret's visual-line edge ([2b901e6](https://github.com/xiaoxinghu/justfiles/commit/2b901e6d6dc7f8bf2211d3ca2e61807afd7783b2))
* **frieren:** only echo the caps subprotocol when the client offered it ([e51ba44](https://github.com/xiaoxinghu/justfiles/commit/e51ba448b87c0059664e2f336cc3fb0b02d8869a))
* **frieren:** polish composer alignment, drop search icon, tame chat radius ([3fe9624](https://github.com/xiaoxinghu/justfiles/commit/3fe9624fd5e066c2475a247425b03e663b08a697))
* **frieren:** remember window position/size across close→reopen ([6e9e838](https://github.com/xiaoxinghu/justfiles/commit/6e9e8381d0457506f03a4b4b4d2191335f2f15a9))
* **frieren:** revoke sandbox blob URLs to stop reducer-frame leak ([392c922](https://github.com/xiaoxinghu/justfiles/commit/392c922dfdf3e5b81aa578522c6f9c8aea280b9d))
* **frieren:** revoke sandbox blob URLs to stop reducer-frame leak ([8a697d7](https://github.com/xiaoxinghu/justfiles/commit/8a697d7edba71562a9eb5e87aaecc7aa0a5894ea))
* **frieren:** ritual fits the viewport, responds, and wears the bound face ([45ff817](https://github.com/xiaoxinghu/justfiles/commit/45ff8179e7f0c16829a87d469503fd8c57d17cf0))
* **frieren:** show focus catcher on unfocused fullscreen windows too ([5977fd4](https://github.com/xiaoxinghu/justfiles/commit/5977fd49b4b5d9f7bb2339355e0b698b2473192b))
* **frieren:** stop desktop drag from starting native text selection ([7cea04b](https://github.com/xiaoxinghu/justfiles/commit/7cea04b25331ea2c42149035ac908165b0412ca2))
* **frieren:** surface the no-AI turn failure in the chat ([610da29](https://github.com/xiaoxinghu/justfiles/commit/610da29f0ef7ea7562dd7a721d4836047661b4fa))
* **frieren:** target captured account on migrate; refresh identity after copy ([e9780c3](https://github.com/xiaoxinghu/justfiles/commit/e9780c3cb7fd46a0667ad15343139e6d91d42a4f))
* **frieren:** theme the conversation composer with design tokens ([bd7c84e](https://github.com/xiaoxinghu/justfiles/commit/bd7c84eb4b32ddb2e6afe95a188b4fbd66f5cbab))
* **fs,frieren:** address PR review — full drain per cycle + /ws self-heal ([53d0853](https://github.com/xiaoxinghu/justfiles/commit/53d0853c0f0364bbb7079a611afac7fe5e192e14))
* **fs:** address 2nd PR review — non-destructive legacy re-bootstrap + lineage write-fence ([95f7a91](https://github.com/xiaoxinghu/justfiles/commit/95f7a918713b448a52b3bcdd1e4f310d0c157d55))
* **fs:** address 4th PR review — fence adopt-mine by lineage + restart-safe migrations ([05360fa](https://github.com/xiaoxinghu/justfiles/commit/05360fab2fd49d88cf80fb69a502e62d6680c2b6))
* **fs:** address 5th PR review — require lineage for adopt-mine + transactionSync migrations ([4e9c66f](https://github.com/xiaoxinghu/justfiles/commit/4e9c66fca68389361eb0d5531c37983dcc81acca))
* **fs:** converge path-sync via unique lineage identity ([9b3c021](https://github.com/xiaoxinghu/justfiles/commit/9b3c021132e3d710ea5ef801fd9929191b6b6df2))
* **fs:** wire path-sync remote replica + fix blob HEAD 500 ([9362764](https://github.com/xiaoxinghu/justfiles/commit/936276477c77def5958f0f187d07023b37eaeb51))
* **kodama:** auto-expire the id-migration backup after 30 days ([c12465d](https://github.com/xiaoxinghu/justfiles/commit/c12465d19544ddbf84a326af2547d736b89c57ea))
* **kodama:** keep the DO daily alarm alive until the migration backup expires ([4950d7f](https://github.com/xiaoxinghu/justfiles/commit/4950d7f474745996b36b7299df26d8a7a9825ae3))
* **kodama:** only back up os-state when it actually holds a legacy id ([9405b4b](https://github.com/xiaoxinghu/justfiles/commit/9405b4bb5412cdaf3c76a15cf9f1340a92a3a8b8))
* **kodama:** sweep migration backups on the DO daily alarm, not only client boot ([2a931de](https://github.com/xiaoxinghu/justfiles/commit/2a931de868d526a5c754b359292a2579c763e118))
* publish Kodama app metadata ([#271](https://github.com/xiaoxinghu/justfiles/issues/271)) ([63115a5](https://github.com/xiaoxinghu/justfiles/commit/63115a5652cdd2d81cbb68579c75b3e85b9fdb2e))
* **pwa:** prompt-based updates + periodic detection ([8ddac3a](https://github.com/xiaoxinghu/justfiles/commit/8ddac3a9fcd2809100c77f5041d8990a5cf3af10))
* **sync:** enforce publishing lock, finalize order, take-mine crash recovery ([db09e78](https://github.com/xiaoxinghu/justfiles/commit/db09e786d85362f18cb283d803e3e3646e7a2cb9))
* **usage:** address Codex review — roll window on read, gate all inference paths, per-resource hint ([dd406da](https://github.com/xiaoxinghu/justfiles/commit/dd406da43d7725cd4bf22627c114018e493e113b))
* **usage:** address Codex round 2 — drain accrual before gate, meter failed images, usage retry state ([a9840ad](https://github.com/xiaoxinghu/justfiles/commit/a9840ad937e099969cce75c280b4f7e9686dd4c2))
* **usage:** address Codex round 3 — serialize inference, exclude orphan blobs, degrade Usage tab off-host ([221af61](https://github.com/xiaoxinghu/justfiles/commit/221af61661f89b5be63291bd1217f07564fcae6e))
* **usage:** address Codex round 4 — worst-case reservation, restore/switch Usage tab ([b988f4b](https://github.com/xiaoxinghu/justfiles/commit/b988f4b476fe3f5dbba43139e26180f9b04f7dfb))
* **usage:** reservations survive month rollover + volume resets (Codex round 5) ([b2a6425](https://github.com/xiaoxinghu/justfiles/commit/b2a64257a46ff57d999e81820a92fc5c9dc5d9e2))


### Performance Improvements

* **frieren:** ship production React in production builds ([949777f](https://github.com/xiaoxinghu/justfiles/commit/949777f849d0b67a5a14e9d7089fb5e08686b050))

## [0.7.0](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.6.0...spud-v0.7.0) (2026-07-24)


### Features

* **kodama:** one-off migrateAppIdsV1 migrator + Frieren RPC ([e0fe630](https://github.com/xiaoxinghu/justfiles/commit/e0fe630e008355f80bb3c10c34280e718404735f))
* **kodama:** rebrand user-facing copy (AI provider name, page title) ([1df282c](https://github.com/xiaoxinghu/justfiles/commit/1df282cd668b31a0662c39e2ed32fe8562f35d79))
* **kodama:** run the id migration automatically on login, before seed ([0f9d79e](https://github.com/xiaoxinghu/justfiles/commit/0f9d79e2652a5d3c2f592bbe61511e629f08b2b9))


### Bug Fixes

* **frieren:** revoke sandbox blob URLs to stop reducer-frame leak ([392c922](https://github.com/xiaoxinghu/justfiles/commit/392c922dfdf3e5b81aa578522c6f9c8aea280b9d))
* **kodama:** auto-expire the id-migration backup after 30 days ([c12465d](https://github.com/xiaoxinghu/justfiles/commit/c12465d19544ddbf84a326af2547d736b89c57ea))
* **kodama:** keep the DO daily alarm alive until the migration backup expires ([4950d7f](https://github.com/xiaoxinghu/justfiles/commit/4950d7f474745996b36b7299df26d8a7a9825ae3))
* **kodama:** only back up os-state when it actually holds a legacy id ([9405b4b](https://github.com/xiaoxinghu/justfiles/commit/9405b4bb5412cdaf3c76a15cf9f1340a92a3a8b8))
* **kodama:** sweep migration backups on the DO daily alarm, not only client boot ([2a931de](https://github.com/xiaoxinghu/justfiles/commit/2a931de868d526a5c754b359292a2579c763e118))

## [0.6.0](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.5.0...spud-v0.6.0) (2026-07-24)


### Features

* **frieren:** dual-window AI caps (rolling 5h burst + fixed weekly) ([13756a6](https://github.com/xiaoxinghu/justfiles/commit/13756a6be456b600f0058db9f57b72ad3334a4d5))
* **fs:** proactive, fs-level sync driven by the volume change feed ([29f4cb0](https://github.com/xiaoxinghu/justfiles/commit/29f4cb08dfc8afe0686c8de7214effb22a9c651e))


### Bug Fixes

* **fs,frieren:** address PR review — full drain per cycle + /ws self-heal ([53d0853](https://github.com/xiaoxinghu/justfiles/commit/53d0853c0f0364bbb7079a611afac7fe5e192e14))
* **fs:** address 2nd PR review — non-destructive legacy re-bootstrap + lineage write-fence ([95f7a91](https://github.com/xiaoxinghu/justfiles/commit/95f7a918713b448a52b3bcdd1e4f310d0c157d55))
* **fs:** address 4th PR review — fence adopt-mine by lineage + restart-safe migrations ([05360fa](https://github.com/xiaoxinghu/justfiles/commit/05360fab2fd49d88cf80fb69a502e62d6680c2b6))
* **fs:** address 5th PR review — require lineage for adopt-mine + transactionSync migrations ([4e9c66f](https://github.com/xiaoxinghu/justfiles/commit/4e9c66fca68389361eb0d5531c37983dcc81acca))
* **fs:** converge path-sync via unique lineage identity ([9b3c021](https://github.com/xiaoxinghu/justfiles/commit/9b3c021132e3d710ea5ef801fd9929191b6b6df2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/fs bumped to 0.4.0

## [0.5.0](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.4.0...spud-v0.5.0) (2026-07-22)


### Features

* **frieren:** dev-only app sideload via FRIEREN_DEV_APPS ([#224](https://github.com/xiaoxinghu/justfiles/issues/224)) ([42c36b8](https://github.com/xiaoxinghu/justfiles/commit/42c36b83ceced3b3ed6e13c16da90a0df881519a))
* **frieren:** lift the platform AI cap in local dev only ([a405986](https://github.com/xiaoxinghu/justfiles/commit/a405986192c35dc8223314592ef5d8910554d35b))
* **frieren:** per-user usage metering ([#212](https://github.com/xiaoxinghu/justfiles/issues/212)) ([788b651](https://github.com/xiaoxinghu/justfiles/commit/788b651763f2137de6ed2f5076cd48e036eb41e0))
* **frieren:** usage caps + tiers (free/pro) with AI pre-turn enforcement ([1c2ee2d](https://github.com/xiaoxinghu/justfiles/commit/1c2ee2db8ac7dde616b978f6d787dac9db073cf4))
* **settings:** Usage panel — AI + storage against plan ([a76942b](https://github.com/xiaoxinghu/justfiles/commit/a76942b1a2fc955d806b28e275257189c0232e15))


### Bug Fixes

* **app:** reflect synced-down agent edits in the open GUI ([#226](https://github.com/xiaoxinghu/justfiles/issues/226)) ([e5b2109](https://github.com/xiaoxinghu/justfiles/commit/e5b210910777e822eeda098ff0f7446fe3146651))
* **frieren:** address Codex review on composers ([47f3b51](https://github.com/xiaoxinghu/justfiles/commit/47f3b5105048682737521c873b77ef23c2348fd7))
* **frieren:** auto-grow omnibar + chat composers like iMessage ([2570921](https://github.com/xiaoxinghu/justfiles/commit/25709210851dbf33cb119856926de16a70c5e76a))
* **frieren:** click anywhere in a window to focus + macOS active/inactive styling ([a128f1c](https://github.com/xiaoxinghu/justfiles/commit/a128f1ccb32c9aba9ced791f6f91377ddf94a77b))
* **frieren:** close omnibar top gap; pin chat send inside the field (iMessage) ([562172c](https://github.com/xiaoxinghu/justfiles/commit/562172c541d6c9facf954c3bdd5a568b67ed044a))
* **frieren:** enforce border-box in useAutoResize so empty composers stay one line ([71997cc](https://github.com/xiaoxinghu/justfiles/commit/71997cc0d303120b5ae3c1f39aa49d536e3a7afb))
* **frieren:** keep os-state v1 readable by pre-placements clients ([d2fee46](https://github.com/xiaoxinghu/justfiles/commit/d2fee46b12c6d77f45ba89c3663b2a347016a96f))
* **frieren:** navigate omnibar results only at the caret's visual-line edge ([2b901e6](https://github.com/xiaoxinghu/justfiles/commit/2b901e6d6dc7f8bf2211d3ca2e61807afd7783b2))
* **frieren:** polish composer alignment, drop search icon, tame chat radius ([3fe9624](https://github.com/xiaoxinghu/justfiles/commit/3fe9624fd5e066c2475a247425b03e663b08a697))
* **frieren:** remember window position/size across close→reopen ([6e9e838](https://github.com/xiaoxinghu/justfiles/commit/6e9e8381d0457506f03a4b4b4d2191335f2f15a9))
* **frieren:** show focus catcher on unfocused fullscreen windows too ([5977fd4](https://github.com/xiaoxinghu/justfiles/commit/5977fd49b4b5d9f7bb2339355e0b698b2473192b))
* **usage:** address Codex review — roll window on read, gate all inference paths, per-resource hint ([dd406da](https://github.com/xiaoxinghu/justfiles/commit/dd406da43d7725cd4bf22627c114018e493e113b))
* **usage:** address Codex round 2 — drain accrual before gate, meter failed images, usage retry state ([a9840ad](https://github.com/xiaoxinghu/justfiles/commit/a9840ad937e099969cce75c280b4f7e9686dd4c2))
* **usage:** address Codex round 3 — serialize inference, exclude orphan blobs, degrade Usage tab off-host ([221af61](https://github.com/xiaoxinghu/justfiles/commit/221af61661f89b5be63291bd1217f07564fcae6e))
* **usage:** address Codex round 4 — worst-case reservation, restore/switch Usage tab ([b988f4b](https://github.com/xiaoxinghu/justfiles/commit/b988f4b476fe3f5dbba43139e26180f9b04f7dfb))
* **usage:** reservations survive month rollover + volume resets (Codex round 5) ([b2a6425](https://github.com/xiaoxinghu/justfiles/commit/b2a64257a46ff57d999e81820a92fc5c9dc5d9e2))

## [0.4.0](https://github.com/xiaoxinghu/justfiles/compare/spud-v0.3.1...spud-v0.4.0) (2026-07-20)


### Features

* **agent,app,frieren:** capability-provided agent tools (Step 3.5), image first ([310f918](https://github.com/xiaoxinghu/justfiles/commit/310f918fc738d954717881233cc753dd73a27d62))
* **agent,ui,frieren:** render generated images inline in the transcript ([#194](https://github.com/xiaoxinghu/justfiles/issues/194)) ([b82f5a7](https://github.com/xiaoxinghu/justfiles/commit/b82f5a705e892cac1d4cad9f5712f92afc8a29be))
* **app,frieren:** add the image capability, backed by Spud over OpenRouter ([07b7112](https://github.com/xiaoxinghu/justfiles/commit/07b71129d5935430624cdc8878d10fdab85c790a))
* **app:** derive agent tools from self-describing capability contracts ([95b03fe](https://github.com/xiaoxinghu/justfiles/commit/95b03fe823419f4b5fa3f2aa4cf127731d0a1d40))
* **frieren:** move the Spud AI backend from OpenAI to OpenRouter ([88f7f62](https://github.com/xiaoxinghu/justfiles/commit/88f7f62ad0e38a09bbdaf026587bfa9653f2004d))


### Bug Fixes

* **frieren,ui:** address image-resolver review findings ([114e36c](https://github.com/xiaoxinghu/justfiles/commit/114e36c115f9c6f96c2ad11a6419c860139b33d0))
* **frieren:** exclude connection credentials from profile migration ([22e2453](https://github.com/xiaoxinghu/justfiles/commit/22e2453cdb45cd6631cdc5571ffca1039ff55602))

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

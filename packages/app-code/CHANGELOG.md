# Changelog

## [0.2.5](https://github.com/xiaoxinghu/justfiles/compare/code-v0.2.4...code-v0.2.5) (2026-08-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/app bumped to 0.4.1

## [0.2.4](https://github.com/xiaoxinghu/justfiles/compare/code-v0.2.3...code-v0.2.4) (2026-08-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/app bumped to 0.4.0

## [0.2.3](https://github.com/xiaoxinghu/justfiles/compare/code-v0.2.2...code-v0.2.3) (2026-08-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/app bumped to 0.3.0

## [0.2.2](https://github.com/xiaoxinghu/justfiles/compare/code-v0.2.1...code-v0.2.2) (2026-08-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @justfiles/app bumped to 0.2.0

## [0.2.1](https://github.com/xiaoxinghu/justfiles/compare/code-v0.2.0...code-v0.2.1) (2026-07-25)


### Bug Fixes

* publish Kodama app metadata ([#271](https://github.com/xiaoxinghu/justfiles/issues/271)) ([63115a5](https://github.com/xiaoxinghu/justfiles/commit/63115a5652cdd2d81cbb68579c75b3e85b9fdb2e))

## [0.2.0](https://github.com/xiaoxinghu/justfiles/compare/code-v0.1.0...code-v0.2.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* **app:** use positional capability args
* **app:** finish pure-core migration, retire legacy surface

### Features

* **app-code:** add live dock icon editor to the preview ([cd2fe2f](https://github.com/xiaoxinghu/justfiles/commit/cd2fe2f541436c4cfdf5d7ceec6ee7f5ee634316))
* **app-code:** automatic Source→App live build loop ([49a3772](https://github.com/xiaoxinghu/justfiles/commit/49a377290af36ca999f9da4b6dae58572f55d76e))
* **app-code:** delete and export a project from settings ([1748b4f](https://github.com/xiaoxinghu/justfiles/commit/1748b4f08154549ba5b5c6eb1ecfe9a7b1bdaa51))
* **app-code:** edit files with CodeMirror and track dirty state ([e1b332e](https://github.com/xiaoxinghu/justfiles/commit/e1b332ec4fc11e63618a851680e51a68358e6463))
* **app-code:** emit types-only devkit sysroot at build ([526b179](https://github.com/xiaoxinghu/justfiles/commit/526b1795479c447dd966564cef376e429e2449df))
* **app-code:** project gallery with create, open, and close ([0c9708f](https://github.com/xiaoxinghu/justfiles/commit/0c9708f1f7929d8cdf101eef94c62a83d574e4ea))
* **app-code:** project settings screen for editing metadata ([a5102d8](https://github.com/xiaoxinghu/justfiles/commit/a5102d8aaff74c30259c153c2025a1f91c245adf))
* **app-code:** read project files from volume ([aca912f](https://github.com/xiaoxinghu/justfiles/commit/aca912f740969fd9fdee8793a4ee2becfbdeb709))
* **app-code:** ship & share drafts via install and pack ([993e31d](https://github.com/xiaoxinghu/justfiles/commit/993e31d8883662c2f5094484d77ba8264ef73632))
* **app-code:** simple editor with a Run/Stop live-preview window ([782e3bc](https://github.com/xiaoxinghu/justfiles/commit/782e3bc2f3c74529685fd991818aab9558fb012f))
* **app-code:** split Source/App view with live editing ([08316e7](https://github.com/xiaoxinghu/justfiles/commit/08316e78ed34c59f50632896b3e18422c44bc8f3))
* **app-code:** state built-in-SDK-only contract; retire frieren baked runtime ([62b407f](https://github.com/xiaoxinghu/justfiles/commit/62b407fba04ffad509d9315340d4b7084bd4cebb))
* **app-code:** Xcode-style preview chrome with live menubar ([b695220](https://github.com/xiaoxinghu/justfiles/commit/b695220771b76ee68b1a5140335b3c7ed6622906))
* **app:** add React GUI default export shim ([19b7641](https://github.com/xiaoxinghu/justfiles/commit/19b7641cc891bcaf19db401081aa6741a2827807))
* **app:** finish pure-core migration, retire legacy surface ([a09c0af](https://github.com/xiaoxinghu/justfiles/commit/a09c0afa53b15bd9f7fecd201cabc4dbb4321cc3))
* **app:** kernel catalog lifecycle events + hidden-id convention ([3f0de5f](https://github.com/xiaoxinghu/justfiles/commit/3f0de5fd3733cde47a32df56419b0e7744baa686))
* **app:** load devkit types from the installed app-code sysroot ([ba0d0a2](https://github.com/xiaoxinghu/justfiles/commit/ba0d0a2fbdcbf3d52d07451e609cca2763c49ee6))
* **app:** use positional capability args ([bfda3f6](https://github.com/xiaoxinghu/justfiles/commit/bfda3f65ac8308acb0b92d0d3db49fd73fdfe154))
* **app:** watch the open file in finder and code ([381d713](https://github.com/xiaoxinghu/justfiles/commit/381d713f894fdb7608afd7e12be0d5e114e89b46))
* **devkit:** add capability to compile and run draft apps in a scoped kernel ([c09629a](https://github.com/xiaoxinghu/justfiles/commit/c09629a595efeb96d21bf24e44dd1328d34b7490))
* **quay:** native mac styling + live app-code preview ([1f183c1](https://github.com/xiaoxinghu/justfiles/commit/1f183c19523a80af4e64f535b668246fa09b2d1f))
* **quay:** overwrite existing app on re-install in Code ([a2c5245](https://github.com/xiaoxinghu/justfiles/commit/a2c52454546209d6f1fb72a7982a95d2e6b863e0))
* **quay:** PNG app icons and Spotlight-style launcher grid ([c7b055b](https://github.com/xiaoxinghu/justfiles/commit/c7b055bff6c83a043681bf5440321db15f78dcdb))
* **volume:** add rm and rename capability methods ([28ca723](https://github.com/xiaoxinghu/justfiles/commit/28ca723c4066441dd28a4788be99f1b75177d68a))


### Bug Fixes

* **app:** keep procedure-private commit edges off the agent surface ([9249834](https://github.com/xiaoxinghu/justfiles/commit/92498349638ae021668caf48395b851aa320a54b))
* **quay:** render app-code previews from runner urls ([2f5780b](https://github.com/xiaoxinghu/justfiles/commit/2f5780bfb183c841d5b0a929e6005bc76edbe01d))

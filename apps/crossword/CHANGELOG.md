# Changelog

## [0.2.0](https://github.com/xiaoxinghu/justfiles/compare/crossword-v0.1.0...crossword-v0.2.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **app:** procedure handles expose app.cap.<name>.<method>(...args) instead of app.invoke(name, method, ...args). The internal RawAppHandle transport keeps invoke.

### Features

* **app:** namespace procedure capability calls under app.cap ([#648](https://github.com/xiaoxinghu/justfiles/issues/648)) ([5520525](https://github.com/xiaoxinghu/justfiles/commit/55205252475d79d78cbfe8ed5bb204328b9fb136))

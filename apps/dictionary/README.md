# Dictionary

A learning-aware dictionary for JustFiles.

Look up a word or short term to get a definition, pronunciation, meanings, examples, and synonyms.
The app uses the JustFiles AI capability to adapt explanations to the reader.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts a local JustFiles host. It also enables the local AI Vite plugin.

## Check

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

## Build

```sh
pnpm build
```

The build writes `manifest.json`, `app.js`, `gui.js`, and the icon to `dist/`.

## Release

Increase `version` in `package.json` and merge the change to `main`. The release workflow checks,
builds, packages, attests, and releases `dictionary.zip`.

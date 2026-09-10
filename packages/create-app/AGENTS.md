# create-app

This package scaffolds standalone apps; it is not an app itself.

- Read [the app contract](../../docs/app.md) before changing starter behavior.
- `index.js` copies `templates/shared`, then `templates/vanilla` or `templates/react`,
  and fills the package name, SDK version, and app identity.
- Files ending in `.template` lose that suffix when copied; this keeps starter tests and
  tool configs out of the scaffolder's own checks.
- Keep generated `AGENTS.md` short. Put detailed app guidance in
  [justfiles/skills](https://github.com/justfiles/skills).
- Generated apps must install outside this monorepo: no `workspace:`, `catalog:`,
  private configs, or paths into this checkout.
- Test CLI changes with `pnpm run test packages/create-app/index.test.ts`.
  For template changes, scaffold both templates outside the workspace, install dependencies,
  and run their `check` script with the published SDK.

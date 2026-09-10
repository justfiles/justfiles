# App development

This is a standalone `@justfiles/app` package. Read `package.json`, `vite.config.ts`,
`src/app.ts`, and `src/gui.ts` (or `.tsx`) first. Inspect the installed SDK types before using an API.

- `src/app.ts` owns durable JSON state and actions shared by the GUI and agent.
  Keep transitions pure and synchronous; use declared capabilities for I/O.
- The GUI renders state and calls the typed client. Keep transient interaction in the GUI.
- Saved state survives upgrades; `init` is only for first launch. Preserve old state compatibility
  and keep the app id in `vite.config.ts` stable once installed.
- Use pnpm, Node, TypeScript, tabs, and Vitest. Keep code and public actions minimal.
- Run `pnpm install`, `pnpm dev` to develop, and `pnpm check` before handing off code.
  Test changed behavior in `src/*.test.ts` and exercise the GUI; see `README.md`.

Load skills only when needed (including their linked references):

- [justfiles-app-authoring](https://github.com/justfiles/skills/blob/main/skills/justfiles-app-authoring/SKILL.md): state, actions, capabilities, GUI, testing, and maintenance.
- [justfiles-app-publishing](https://github.com/justfiles/skills/blob/main/skills/justfiles-app-publishing/SKILL.md): releases and catalog publication when requested.
- [justfiles-app](https://github.com/justfiles/skills/blob/main/skills/justfiles-app/SKILL.md): work spanning both phases.

Use an installed skill or read the linked file directly. To install the collection in this project:
`pnpm dlx skills add justfiles/skills --skill '*' --yes`. Load only the relevant skill.

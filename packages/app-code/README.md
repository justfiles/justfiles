# app-code (mirror)

**The source of truth is [`justfiles/app-code`](https://github.com/justfiles/app-code).**
Edit Code there. This copy exists only so `FRIEREN_DEV_APPS=app-code pnpm dev` can sideload
a local build, and it is not shipped or published from here.

Code reaches frieren and mac through JustApps: its own repository cuts the release, the
runner imports it, and `BUILTIN_IDS` in `apps/shared/justapps.ts` seeds it.

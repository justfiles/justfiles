// `devkit` can run arbitrary code and write `/applications`, so it is granted
// deliberately, not declared-and-go. v1 is a constant allowlist (mirroring
// `SYSTEM_SCOPE_ALLOWLIST` for finder's system volume); slice 6 replaces it
// with a one-time user-consent grant. `app.test.devkit` is the throwaway used
// to verify the capability standalone.
export const DEVKIT_ALLOWLIST = new Set(['app.code', 'app.test.devkit'])

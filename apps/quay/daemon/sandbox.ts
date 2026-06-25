import { nodeSandbox } from '../quayd/nodeSandbox'

// App bundles are self-contained (the reducer compile bundles the SDK into `app.js`), so the
// sandbox just spawns a content-addressed worker per bundle — no SDK injection at spawn.
export const getSandbox = nodeSandbox().get

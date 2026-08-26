import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import ssrPlugin from 'vite-ssr-components/plugin'

// The Worker itself runs in the `cloudflare()` environment (config from
// wrangler.jsonc); platform client code (`src/client/*`) is an ordinary Vite
// client build served as static assets. `ssrPlugin` is what connects the two:
// it collects the `<Script>` entries out of the SSR'd JSX into the client
// build input, and resolves each one to the source path in dev and to the
// hashed, manifest-mapped asset in production. Nothing else is needed —
// `assets.directory` is written into the generated wrangler config at build.
export default defineConfig({
	plugins: [cloudflare(), ssrPlugin()]
})

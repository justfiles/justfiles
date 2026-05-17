import type { Plugin } from 'vite'
import type { createHost, HostOptions } from './host'

// Thin, config-loader-safe shim. The kernel/fs/esbuild logic lives in ./host
// and is loaded through vite's own pipeline (ssrLoadModule) so its TypeScript
// source + extensionless imports resolve like normal app code.
export function kernelHost(opts: HostOptions): Plugin {
	return {
		name: 'kernel-host',
		config: () => ({ appType: 'custom' }),
		configureServer(server) {
			return async () => {
				const host = (await server.ssrLoadModule('@justfiles/app/kernel/host')) as {
					createHost: typeof createHost
				}
				server.middlewares.use(await host.createHost(server.config.root, opts))
			}
		}
	}
}

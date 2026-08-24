import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import { serveToolchain } from '@justfiles/app/toolchain/worker'

let esbuildReady: Promise<typeof import('esbuild-wasm')> | undefined

function getEsbuild(): Promise<typeof import('esbuild-wasm')> {
	esbuildReady ??= (async () => {
		const esbuild = await import('esbuild-wasm')
		const { default: wasmURL } = await import('esbuild-wasm/esbuild.wasm?url')
		await esbuild.initialize({ wasmURL })
		return esbuild
	})()
	return esbuildReady
}

const scope = globalThis as unknown as {
	postMessage(message: unknown): void
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

serveToolchain(
	{
		compile: async (input, runtime, imports) =>
			esbuildCompile(input, (await getEsbuild()).build, runtime, imports),
		typecheck: async (input, types, paths, imports) =>
			(await import('./devkit.toolchain.typescript.ts')).typecheck(input, types, paths, imports)
	},
	{
		post: (message) => scope.postMessage(message),
		onMessage: (handle) => scope.addEventListener('message', (event) => handle(event.data))
	}
)

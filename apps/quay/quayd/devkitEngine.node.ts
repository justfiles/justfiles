// The Node side of `#engine`: quay's devkit compile backend under Node is native
// esbuild bound into the bundler-agnostic `Compile` seam. Runtime is injected
// per-call (quay builds it once and closes it in). The Bun sibling
// (`devkitEngine.bun.ts`) swaps `Bun.build` in with no other change; typecheck
// stays on tsc either way (devkit.ts).

import type { CompileResult, ProjectInput } from '@justfiles/app/capabilities/devkit/host'
import { esbuildCompile } from '@justfiles/app/toolchain/esbuild'
import { build } from 'esbuild'

export function compile(
	input: ProjectInput,
	runtime: Record<string, string>
): Promise<CompileResult> {
	return esbuildCompile(input, build, runtime)
}

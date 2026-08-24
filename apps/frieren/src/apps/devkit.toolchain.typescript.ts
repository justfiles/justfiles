import type {
	ProjectInput,
	ResolvedImports,
	TypePaths,
	TypesBundle
} from '@justfiles/app/capabilities/devkit/host'
import { tsTypecheckImports } from '@justfiles/app/toolchain/typescript'
import * as ts from 'typescript'

const libraries = import.meta.glob('../../node_modules/typescript/lib/lib.*.d.ts', {
	eager: true,
	import: 'default',
	query: '?raw'
}) as Record<string, string>

const standardTypes = Object.fromEntries(
	Object.entries(libraries).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text])
)

export function typecheck(
	input: ProjectInput,
	types: TypesBundle,
	paths: TypePaths,
	imports?: ResolvedImports
) {
	return tsTypecheckImports(input, ts, { ...standardTypes, ...types }, paths, imports)
}

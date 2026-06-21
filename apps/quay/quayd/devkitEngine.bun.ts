// The Bun side of `#engine`: quay's devkit compile backend under Bun is `Bun.build`
// (in the embedded runtime — no external toolchain), with the same `(input, runtime)
// → CompileResult` shape as the Node sibling. Selected by the `bun` import condition;
// never resolved under Node.

export { bunCompile as compile } from '@justfiles/app/toolchain/bun'

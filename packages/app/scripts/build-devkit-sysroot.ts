import { join } from 'node:path'
import { writeSysroot } from '../capabilities/devkit/devkit-runtime.ts'

await writeSysroot(join(import.meta.dirname, '..', 'dist', 'devkit-sysroot'))

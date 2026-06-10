import { ElectronAPI } from '@electron-toolkit/preload'
import type { DebugDirent, LauncherApp } from '../shared/kernel'

declare global {
	interface Window {
		electron: ElectronAPI
		api: {
			openApp: (id: string) => void
			resizeLauncher: (height: number) => void
			kernelList: () => Promise<LauncherApp[]>
			kernelState: (id: string) => Promise<unknown>
			kernelDispatch: (id: string, message: unknown) => Promise<unknown>
			kernelSubscribe: (id: string, onState: (state: unknown) => void) => () => void
			kernelLs: (path?: string) => Promise<DebugDirent[]>
		}
	}
}

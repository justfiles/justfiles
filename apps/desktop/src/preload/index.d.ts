import { ElectronAPI } from '@electron-toolkit/preload'
import type { DebugDirent, LauncherApp } from '../shared/kernel'

declare global {
	interface Window {
		electron: ElectronAPI
		api: {
			openApp: (id: string) => void
			resizeLauncher: (height: number) => void
			kernelList: () => Promise<LauncherApp[]>
			kernelLs: (path?: string) => Promise<DebugDirent[]>
		}
	}
}

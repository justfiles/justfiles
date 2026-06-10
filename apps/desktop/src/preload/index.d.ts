import { ElectronAPI } from '@electron-toolkit/preload'

type DebugDirent = { ino: string; name: string; type: number }

declare global {
	interface Window {
		electron: ElectronAPI
		api: {
			openApp: (name: string) => void
			resizeLauncher: (height: number) => void
			kernelLs: (path?: string) => Promise<DebugDirent[]>
		}
	}
}

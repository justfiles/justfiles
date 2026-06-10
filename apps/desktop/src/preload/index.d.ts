import { ElectronAPI } from '@electron-toolkit/preload'
import type { AgentMessage } from '../shared/agent'
import type { DebugDirent, LauncherApp } from '../shared/kernel'

declare global {
	interface Window {
		electron: ElectronAPI
		api: {
			openApp: (id: string) => void
			openAgent: () => void
			resizeLauncher: (height: number) => void
			catalogSubscribe: (onChange: () => void) => () => void
			kernelList: () => Promise<LauncherApp[]>
			kernelState: (id: string) => Promise<unknown>
			kernelDispatch: (id: string, message: unknown) => Promise<unknown>
			kernelSubscribe: (id: string, onState: (state: unknown) => void) => () => void
			kernelLs: (path?: string) => Promise<DebugDirent[]>
			previewRect: (
				ownerAppId: string,
				rect: { x: number; y: number; width: number; height: number }
			) => void
			agentHistory: () => Promise<AgentMessage[]>
			agentPrompt: (input: string) => Promise<string>
			agentAbort: () => Promise<void>
			agentSubscribe: (onChange: () => void) => () => void
		}
	}
}

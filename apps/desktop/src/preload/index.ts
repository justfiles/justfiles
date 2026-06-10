import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import type { DebugDirent, LauncherApp } from '../shared/kernel'

// Custom APIs for renderer
const api = {
	openApp: (id: string): void => ipcRenderer.send('launcher:open-app', id),
	resizeLauncher: (height: number): void => ipcRenderer.send('launcher:resize', height),
	kernelList: (): Promise<LauncherApp[]> => ipcRenderer.invoke('kernel:list'),
	kernelState: (id: string): Promise<unknown> => ipcRenderer.invoke('kernel:state', id),
	kernelDispatch: (id: string, message: unknown): Promise<unknown> =>
		ipcRenderer.invoke('kernel:dispatch', id, message),
	kernelSubscribe: (id: string, onState: (state: unknown) => void): (() => void) => {
		const listener = (_event: IpcRendererEvent, appId: string, state: unknown) => {
			if (appId === id) onState(state)
		}
		ipcRenderer.on('app.update', listener)
		return () => ipcRenderer.off('app.update', listener)
	},
	kernelLs: (path = '/'): Promise<DebugDirent[]> => ipcRenderer.invoke('kernel:ls', path)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
	try {
		contextBridge.exposeInMainWorld('electron', electronAPI)
		contextBridge.exposeInMainWorld('api', api)
	} catch (error) {
		console.error(error)
	}
} else {
	// @ts-expect-error (define in dts)
	window.electron = electronAPI
	// @ts-expect-error (define in dts)
	window.api = api
}

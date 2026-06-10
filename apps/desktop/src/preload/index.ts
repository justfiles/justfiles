import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'
import type { DebugDirent, LauncherApp } from '../shared/kernel'

// Custom APIs for renderer
const api = {
	openApp: (id: string): void => ipcRenderer.send('launcher:open-app', id),
	resizeLauncher: (height: number): void => ipcRenderer.send('launcher:resize', height),
	kernelList: (): Promise<LauncherApp[]> => ipcRenderer.invoke('kernel:list'),
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

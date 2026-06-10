import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

type DebugDirent = { ino: string; name: string; type: number }

// Custom APIs for renderer
const api = {
	openApp: (name: string): void => ipcRenderer.send('launcher:open-app', name),
	resizeLauncher: (height: number): void => ipcRenderer.send('launcher:resize', height),
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

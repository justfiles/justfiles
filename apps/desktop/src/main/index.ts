import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from 'electron'
import icon from '../../resources/icon.png?asset'

const LAUNCHER_WIDTH = 600

let launcherWin: BrowserWindow | null = null

function createLauncher(): BrowserWindow {
	const win = new BrowserWindow({
		width: LAUNCHER_WIDTH,
		height: 64,
		useContentSize: true,
		show: false,
		frame: false,
		transparent: true,
		vibrancy: 'under-window',
		visualEffectState: 'active',
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		roundedCorners: true,
		// macOS nonactivating NSPanel: takes keystrokes without activating our
		// agent, so summoning shows on the *current* Space instead of yanking
		// focus to the launcher's home Space (Sol/Raycast/Spotlight behaviour).
		...(process.platform === 'darwin' ? { type: 'panel' } : {}),
		...(process.platform === 'linux' ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		}
	})

	win.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url)
		return { action: 'deny' }
	})

	// Sol-style panel behaviour: dismiss the moment it loses focus or on Escape
	// (Spotlight UX). Cross-Space visibility is (re-)applied in showLauncher.
	win.on('blur', () => {
		if (!win.webContents.isDevToolsOpened()) win.hide()
	})
	win.webContents.on('before-input-event', (_e, input) => {
		if (input.key === 'Escape') win.hide()
	})

	// HMR for renderer based on electron-vite cli.
	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL)
	} else {
		win.loadFile(join(__dirname, '../renderer/index.html'))
	}

	return win
}

// Center the launcher on the display under the cursor, biased toward the top
// third (Spotlight/Raycast placement), then reveal it.
function showLauncher(): void {
	if (!launcherWin) launcherWin = createLauncher()
	const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
	const [w, h] = launcherWin.getSize()
	launcherWin.setPosition(
		Math.round(workArea.x + (workArea.width - w) / 2),
		Math.round(workArea.y + (workArea.height - h) / 3)
	)
	// Re-stamp collectionBehavior on every show: macOS drops it after some
	// Space/display transitions, which otherwise pins the panel to one Space and
	// yanks focus back to it on summon (electron#8734).
	launcherWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	// show() makes the nonactivating panel key (renderer autofocuses its input on
	// the DOM focus event) WITHOUT calling focus(): focus() runs
	// activateIgnoringOtherApps, which activates the whole app and yanks macOS to
	// the Space of the app's frontmost ordinary window — the actual Space jump.
	launcherWin.show()
}

function toggleLauncher(): void {
	if (launcherWin?.isVisible()) {
		launcherWin.hide()
	} else {
		showLauncher()
	}
}

// Open a chosen app in its own normal window. Closing it doesn't affect the
// launcher or other app windows. The renderer branches on ?app=<name>.
function openAppWindow(name: string): void {
	const win = new BrowserWindow({
		width: 800,
		height: 600,
		title: name,
		show: false,
		...(process.platform === 'linux' ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		}
	})

	win.on('ready-to-show', () => win.show())

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?app=${encodeURIComponent(name)}`)
	} else {
		win.loadFile(join(__dirname, '../renderer/index.html'), { query: { app: name } })
	}
}

app.whenReady().then(() => {
	electronApp.setAppUserModelId('com.electron')

	// Run as a background agent: no Dock icon, no window on launch.
	app.dock?.hide()

	app.on('browser-window-created', (_, window) => {
		optimizer.watchWindowShortcuts(window)
	})

	ipcMain.on('launcher:open-app', (_e, name: string) => {
		openAppWindow(name)
		// Dismiss the launcher once an app is chosen, like Spotlight.
		launcherWin?.hide()
	})

	// The renderer reports its content height so the window fits like Raycast.
	ipcMain.on('launcher:resize', (e, height: number) => {
		if (!launcherWin || e.sender !== launcherWin.webContents) return
		launcherWin.setContentSize(LAUNCHER_WIDTH, Math.max(1, Math.ceil(height)))
	})

	if (!globalShortcut.register('Alt+Space', toggleLauncher)) {
		console.warn('Failed to register Alt+Space global shortcut')
	}

	// Keep the launcher visible while iterating in dev.
	if (!app.isPackaged) showLauncher()
})

app.on('will-quit', () => {
	globalShortcut.unregisterAll()
})

// No quit on window-all-closed: the launcher only hides, and the agent must
// keep running with no windows open so the hotkey can summon it again.

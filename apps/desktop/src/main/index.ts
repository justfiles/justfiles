import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from 'electron'
import icon from '../../resources/icon.png?asset'

let launcherWin: BrowserWindow | null = null

function createLauncher(): BrowserWindow {
	const win = new BrowserWindow({
		width: 600,
		height: 400,
		show: false,
		frame: false,
		transparent: true,
		vibrancy: 'under-window',
		visualEffectState: 'active',
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		roundedCorners: true,
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
	launcherWin.show()
	launcherWin.focus()
}

function toggleLauncher(): void {
	if (launcherWin?.isVisible()) {
		launcherWin.hide()
	} else {
		showLauncher()
	}
}

app.whenReady().then(() => {
	electronApp.setAppUserModelId('com.electron')

	// Run as a background agent: no Dock icon, no window on launch.
	app.dock?.hide()

	app.on('browser-window-created', (_, window) => {
		optimizer.watchWindowShortcuts(window)
	})

	ipcMain.on('ping', () => console.log('pong'))

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

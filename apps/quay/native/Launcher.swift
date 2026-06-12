import Carbon.HIToolbox
import Cocoa
import Darwin
import WebKit

// The launcher: an LSUIElement agent whose global hotkey (Option+Space) toggles a
// frameless, vibrancy-blurred panel. The panel hosts the launcher web UI; picking
// an app launches its real .app bundle via LaunchServices — by bundle, not as a
// window of the launcher — which is what gives each app its own Dock identity.
// It is also the privileged client of quayd: it ensures the daemon is running and
// hands the web UI its {port, token} so the UI can pull the catalog over the socket.

final class LauncherDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
	WKScriptMessageHandler, WKScriptMessageHandlerWithReply
{
	private var panel: NSPanel!
	private var webView: WKWebView!
	private var hotkey: Hotkey?

	func applicationDidFinishLaunching(_: Notification) {
		buildPanel()
		// Summoned by the hotkey, not shown on launch: an LSUIElement app can't take
		// foreground at launch, and the panel is meant to be toggled like Spotlight.
		hotkey = Hotkey(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)) { [weak self] in
			self?.toggle()
		}
	}

	private func buildPanel() {
		let rect = NSRect(x: 0, y: 0, width: 640, height: 72)
		panel = KeyablePanel(
			contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false
		)
		panel.level = .floating
		panel.isFloatingPanel = true
		panel.becomesKeyOnlyIfNeeded = false
		panel.isOpaque = false
		panel.backgroundColor = .clear
		panel.hasShadow = true
		panel.isMovableByWindowBackground = true
		panel.delegate = self

		let blur = NSVisualEffectView(frame: rect)
		blur.material = .hudWindow
		blur.blendingMode = .behindWindow
		blur.state = .active
		blur.autoresizingMask = [.width, .height]
		blur.wantsLayer = true
		blur.layer?.cornerRadius = 16
		blur.layer?.masksToBounds = true

		let cfg = WKWebViewConfiguration()
		cfg.userContentController.add(self, name: "quay")
		cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "quayd")
		cfg.userContentController.addUserScript(
			WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
		)
		webView = WKWebView(frame: rect, configuration: cfg)
		webView.autoresizingMask = [.width, .height]
		webView.setValue(false, forKey: "drawsBackground") // let vibrancy show through
		if #available(macOS 13.3, *) { webView.isInspectable = true } // dev only
		blur.addSubview(webView)
		panel.contentView = blur

		let dir = Bundle.main.resourceURL!.appendingPathComponent("launcher-ui")
		webView.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
	}

	private func toggle() { panel.isVisible ? hide() : show() }

	private func show() {
		resizePanel(to: 72)
		// Top-left, just below the menu bar, on whichever screen the pointer is on.
		let screen =
			NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }
				?? NSScreen.main ?? NSScreen.screens.first
		if let v = screen?.visibleFrame {
			let f = panel.frame
			let margin: CGFloat = 24
			let x = v.minX + margin
			let y = v.maxY - f.height - margin
			panel.setFrameOrigin(NSPoint(x: x, y: y))
		}
		NSApp.activate(ignoringOtherApps: true)
		panel.makeKeyAndOrderFront(nil)
		// Reconnect now the view is visible: ensures quayd and refreshes the list
		// even if it was killed (and our timers suspended) while we were hidden.
		let script =
			"window.quayShown ? window.quayShown() : (window.quayConnect && window.quayConnect())"
		webView.evaluateJavaScript(script, completionHandler: nil)
	}

	private func hide() { panel.orderOut(nil) }

	private func resizePanel(to height: CGFloat) {
		let f = panel.frame
		let h = max(72, min(height, 640))
		panel.setFrame(NSRect(x: f.minX, y: f.maxY - h, width: f.width, height: h), display: true)
	}

	// Spotlight-style: dismiss when focus leaves the panel.
	func windowDidResignKey(_: Notification) { hide() }

	// Bridge from launcher-ui (window.quay.*).
	func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
		guard let body = message.body as? [String: Any], let action = body["action"] as? String
		else { return }
		switch action {
		case "open":
			if let id = body["id"] as? String {
				hide()
				openMiniApp(id)
			}
		case "hide":
			hide()
		case "resize":
			if let height = body["height"] as? NSNumber { resizePanel(to: CGFloat(height.doubleValue)) }
		default:
			break
		}
	}

	// Reply bridge (window.quay.runtime): ensure quayd is up, off the main thread,
	// then hand the web UI its {port, token} so it can open the socket.
	func userContentController(
		_: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void
	) {
		guard (message.body as? [String: Any])?["action"] as? String == "runtime" else {
			replyHandler(nil, "unknown")
			return
		}
		DispatchQueue.global().async {
			let runtime = Quayd.ensure()
			DispatchQueue.main.async {
				if let runtime {
					replyHandler(["port": runtime.port, "token": runtime.token], nil)
				} else {
					replyHandler(nil, "quayd unavailable")
				}
			}
		}
	}

	private func openMiniApp(_ id: String) {
		let ws = NSWorkspace.shared
		let cfg = NSWorkspace.OpenConfiguration()
		cfg.activates = true

		// Launch by bundle id (LaunchServices) — its own process, own Dock identity.
		let bundleId = "app.justfiles.quay.app.\(id)"
		if let url = ws.urlForApplication(withBundleIdentifier: bundleId) {
			ws.openApplication(at: url, configuration: cfg)
			return
		}
		// Dev fallback: the generated bundle on disk if it isn't registered yet.
		let path = FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Applications/Quay Apps/\(id.capitalized).app")
		if FileManager.default.fileExists(atPath: path.path) {
			ws.openApplication(at: path, configuration: cfg)
		} else {
			NSSound.beep()
		}
	}

	static let bridgeJS = """
	window.quay = {
	  open: function (id) { window.webkit.messageHandlers.quay.postMessage({ action: 'open', id: id }) },
	  hide: function () { window.webkit.messageHandlers.quay.postMessage({ action: 'hide' }) },
	  resize: function (height) { window.webkit.messageHandlers.quay.postMessage({ action: 'resize', height: height }) },
	  runtime: function () { return window.webkit.messageHandlers.quayd.postMessage({ action: 'runtime' }) }
	}
	"""
}

// Find-or-spawn the quayd daemon. Discovery is via runtime.json ({port, token,
// pid}); liveness via the pid. If it is absent or dead, spawn node on the quayd
// entrypoint (paths stamped into Info.plist by build.sh) and wait for it to
// advertise itself. A single-writer lock is deferred (Phase 4 hardening).
enum Quayd {
	struct Runtime: Decodable {
		let port: Int
		let token: String
		let pid: Int
	}

	static let supportDir = FileManager.default.homeDirectoryForCurrentUser
		.appendingPathComponent("Library/Application Support/quay")
	static var runtimePath: URL { supportDir.appendingPathComponent("runtime.json") }

	static func read() -> Runtime? {
		guard let data = try? Data(contentsOf: runtimePath) else { return nil }
		return try? JSONDecoder().decode(Runtime.self, from: data)
	}

	static func alive(_ r: Runtime) -> Bool { kill(pid_t(r.pid), 0) == 0 }

	static func ensure() -> Runtime? {
		if let r = read(), alive(r) { return r }
		spawn()
		for _ in 0..<50 { // up to ~5s for the daemon to advertise itself
			usleep(100_000)
			if let r = read(), alive(r) { return r }
		}
		return read()
	}

	private static func spawn() {
		let info = Bundle.main.infoDictionary ?? [:]
		guard let node = info["QuaydNode"] as? String,
			let script = info["QuaydScript"] as? String
		else { return }
		let p = Process()
		p.executableURL = URL(fileURLWithPath: node)
		// `--import tsx`: the kernel/fs packages are TS source with extensionless
		// internal imports, so quayd runs through the tsx loader (resolved from the
		// quayd dir's node_modules) rather than bare `node`. `rawLoader.mjs` (next to
		// the entrypoint, loaded first) teaches node the agent's `?raw` md imports.
		let rawLoader = URL(fileURLWithPath: script).deletingLastPathComponent()
			.appendingPathComponent("rawLoader.mjs").path
		p.arguments = ["--import", rawLoader, "--import", "tsx", script]
		p.currentDirectoryURL = URL(fileURLWithPath: script).deletingLastPathComponent()
		// Log to a file so a GUI-spawned daemon (no inherited terminal) is debuggable.
		try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
		let log = supportDir.appendingPathComponent("quayd.log")
		FileManager.default.createFile(atPath: log.path, contents: nil)
		if let handle = try? FileHandle(forWritingTo: log) {
			handle.seekToEndOfFile()
			p.standardOutput = handle
			p.standardError = handle
		}
		try? p.run()
	}
}

// Borderless windows can't become key by default; the search field needs focus.
final class KeyablePanel: NSPanel {
	override var canBecomeKey: Bool { true }
	override var canBecomeMain: Bool { true }
}

// A global Option+Space hotkey via Carbon (no Accessibility permission required).
final class Hotkey {
	private var ref: EventHotKeyRef?
	private let onPress: () -> Void

	init(keyCode: UInt32, modifiers: UInt32, onPress: @escaping () -> Void) {
		self.onPress = onPress
		var spec = EventTypeSpec(
			eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)
		)
		let this = Unmanaged.passUnretained(self).toOpaque()
		InstallEventHandler(
			GetApplicationEventTarget(),
			{ _, _, userData in
				Unmanaged<Hotkey>.fromOpaque(userData!).takeUnretainedValue().onPress()
				return noErr
			}, 1, &spec, this, nil
		)
		let hkId = EventHotKeyID(signature: 0x5155_4159 /* 'QUAY' */, id: 1)
		RegisterEventHotKey(keyCode, modifiers, hkId, GetApplicationEventTarget(), 0, &ref)
	}
}

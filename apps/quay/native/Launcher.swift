import Carbon.HIToolbox
import Cocoa
import WebKit

// The launcher: an LSUIElement agent whose global hotkey (Option+Space) toggles a
// frameless, vibrancy-blurred panel. The panel hosts the launcher web UI; picking
// an app launches its real .app bundle via LaunchServices — by bundle, not as a
// window of the launcher — which is what gives each app its own Dock identity.

final class LauncherDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
	WKScriptMessageHandler
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
		let rect = NSRect(x: 0, y: 0, width: 640, height: 460)
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
		blur.material = .sidebar
		blur.blendingMode = .behindWindow
		blur.state = .active
		blur.autoresizingMask = [.width, .height]
		blur.wantsLayer = true
		blur.layer?.cornerRadius = 16
		blur.layer?.masksToBounds = true

		let cfg = WKWebViewConfiguration()
		cfg.userContentController.add(self, name: "quay")
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
		// Centre, upper-third, on whichever screen the pointer is on.
		let screen =
			NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }
				?? NSScreen.main ?? NSScreen.screens.first
		if let v = screen?.visibleFrame {
			let f = panel.frame
			let x = v.minX + (v.width - f.width) / 2
			let y = v.minY + (v.height - f.height) * 0.62
			panel.setFrameOrigin(NSPoint(x: x, y: y))
		}
		NSApp.activate(ignoringOtherApps: true)
		panel.makeKeyAndOrderFront(nil)
	}

	private func hide() { panel.orderOut(nil) }

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
		default:
			break
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
	  hide: function () { window.webkit.messageHandlers.quay.postMessage({ action: 'hide' }) }
	}
	"""
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

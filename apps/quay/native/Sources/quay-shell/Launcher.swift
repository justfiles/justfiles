import Carbon.HIToolbox
import Cocoa
import Darwin
import WebKit

// The launcher: an LSUIElement agent whose global hotkey (Option+Space) toggles a
// frameless, vibrancy-blurred panel. The chrome — composer + app results — is native
// AppKit (no web-view resize round-trip, so no per-keystroke flash); the agent
// transcript is a transparent WKWebView served by quayd (the shared React <Transcript/>).
// Picking an app launches its real .app bundle via LaunchServices — by bundle, not as a
// window of the launcher — which gives each app its own Dock identity. The launcher is
// also quayd's privileged client: it discovers the daemon (via CatalogClient) for both
// the native catalog socket and the transcript webview's {port, token}.

final class LauncherDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
	WKScriptMessageHandler
{
	private static let panelWidth: CGFloat = 640
	private static let pad: CGFloat = 12 // inset around the panel content
	private static let gap: CGFloat = 8 // between the content region and the composer
	private static let baseHeight: CGFloat = pad * 2 + Composer.minHeight // collapsed bar
	// The content region above the composer. Fixed and shared by the app grid and the chat
	// transcript, so switching between them never resizes the panel (each scrolls within it).
	// The panel's bottom edge stays pinned, so its on-screen position never shifts.
	private static let surfaceHeight: CGFloat = 460
	// The Settings mini-app's catalog id — the target a `settings` route opens. The route
	// carries only `kind`/`pane`, so the launcher (which knows the host catalog) names the app.
	private static let settingsAppId = "app.frieren.settings"

	// What sits above the composer right now. The launcher rests in `grid` (the app
	// springboard — every app on summon, filtered as you type); when a query matches no app
	// we switch straight to `chat`. ⌘K also enters chat. A leading `/` opens the `commands`
	// menu over whatever mode we were in.
	private enum Content { case grid, chat, commands }

	private var panel: NSPanel!
	private var container: NSView! // holds the active content view, sized per mode
	private var webView: WKWebView! // the transcript, kept warm (loaded at startup)
	private let composer = Composer()
	private let results = Results() // the `/` command menu
	private let grid = AppGrid() // the app springboard
	private let stopButton = NSButton()
	private let catalog = CatalogClient()
	private let notifier = Notifier()
	private var hotkey: Hotkey?

	private var apps: [CatalogApp] = []
	private var commands: [CatalogCommand] = []
	private var chatting = false
	private var content: Content = .grid
	private var visibleContent: NSView?
	private var chatRuntime: (port: Int, token: String)?

	func applicationDidFinishLaunching(_: Notification) {
		buildPanel()
		// Discover quayd now: the catalog socket fills the results list, and its onRuntime
		// loads the transcript webview warm so entering chat is a reveal, not a cold load.
		catalog.onCatalog = { [weak self] in self?.catalogArrived($0) }
		catalog.onCommands = { [weak self] in self?.commands = $0 }
		catalog.onRuntime = { [weak self] port, token in self?.useRuntime(port, token) }
		// Notifications arrive over the same socket; the launcher suppresses by focus
		// and posts to the OS, and resolves a banner click back into a route.
		catalog.onNotification = { [weak self] in self?.notificationArrived($0) }
		notifier.onRoute = { [weak self] in self?.handleRoute($0) }
		catalog.connect()
		// Summoned by the hotkey, not shown on launch: an LSUIElement app can't take
		// foreground at launch, and the panel is meant to be toggled like Spotlight.
		hotkey = Hotkey(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)) { [weak self] in
			self?.toggle()
		}
	}

	private func buildPanel() {
		let rect = NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.baseHeight)
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
		// A hairline light edge for a crisp, defined boundary (Spotlight has one).
		blur.layer?.borderWidth = 1
		blur.layer?.borderColor = NSColor(white: 1, alpha: 0.1).cgColor
		panel.contentView = blur

		// A dark tint over the vibrancy: the bare HUD blur reads washed-out/too see-through,
		// so this firms the glass up into Spotlight's more solid, less-blurry look. Sits
		// below all content (added before container/composer), clipped to the rounded corners.
		let tint = NSView(frame: rect)
		tint.wantsLayer = true
		tint.layer?.backgroundColor = NSColor(white: 0, alpha: 0.22).cgColor
		tint.autoresizingMask = [.width, .height]
		blur.addSubview(tint)

		// The transcript webview: transparent over the native vibrancy, status-bridged,
		// kept warm. Its agent socket and token are owned by the page (quayd injects the
		// token); native only drives input (quaySend/quayAbort) and reads `status`.
		let cfg = WKWebViewConfiguration()
		cfg.userContentController.add(self, name: "status")
		webView = WKWebView(frame: .zero, configuration: cfg)
		webView.setValue(false, forKey: "drawsBackground")
		if #available(macOS 13.3, *) { webView.isInspectable = true } // dev only

		// One content container above the composer; its single visible child swaps per mode.
		container = NSView()
		results.autoresizingMask = [.width, .height]
		grid.autoresizingMask = [.width, .height]
		webView.autoresizingMask = [.width, .height]
		results.onPick = { [weak self] in self?.runCommand($0) }
		grid.onPick = { [weak self] in self?.launch($0) }
		container.addSubview(results)
		container.addSubview(grid)
		container.addSubview(webView)
		blur.addSubview(container)

		composer.onChange = { [weak self] in self?.render() }
		composer.onSubmit = { [weak self] in self?.submit() }
		composer.onEscape = { [weak self] in self?.hide() }
		composer.onToggleChat = { [weak self] in self?.toggleChat() }
		// Arrows browse the active surface: the grid in 2-D, the `/` menu vertically.
		composer.onArrow = { [weak self] dx, dy in
			guard let self else { return }
			if self.content == .commands {
				if dy != 0 { self.results.move(up: dy < 0) }
			} else {
				self.grid.move(dx: dx, dy: dy)
			}
		}
		// A correct width up front so the first desiredHeight measurement wraps properly.
		composer.frame = NSRect(
			x: Self.pad, y: Self.pad, width: Self.panelWidth - Self.pad * 2, height: Composer.minHeight
		)
		blur.addSubview(composer)

		stopButton.title = "Stop"
		stopButton.bezelStyle = .rounded
		stopButton.isHidden = true
		stopButton.target = self
		stopButton.action = #selector(stopStreaming)
		blur.addSubview(stopButton)
	}

	// MARK: layout & sizing — native owns the panel frame, so there is no web→native
	// resize call: the panel grows upward from a pinned bottom edge as content changes.

	private func contentHeight() -> CGFloat {
		switch content {
		case .grid, .chat: return Self.surfaceHeight
		case .commands: return min(results.contentHeight, Results.cap)
		}
	}

	// Resize the panel to fit the current composer + content, keeping the bottom pinned.
	private func sizePanel() {
		let composerH = composer.desiredHeight
		let contentH = contentHeight()
		var h = Self.pad * 2 + composerH
		if contentH > 0 { h += contentH + Self.gap }
		h = max(Self.baseHeight, min(h, 760))
		let f = panel.frame
		panel.setFrame(NSRect(x: f.minX, y: f.minY, width: f.width, height: h), display: true)
		layoutSubviews()
	}

	// Position the composer (bottom), the content container (above it), and the Stop
	// overlay within the panel's current bounds. Never calls sizePanel — no recursion.
	private func layoutSubviews() {
		guard let blur = panel.contentView else { return }
		let width = blur.bounds.width
		let innerWidth = width - Self.pad * 2
		let composerH = composer.desiredHeight
		composer.frame = NSRect(x: Self.pad, y: Self.pad, width: innerWidth, height: composerH)
		let contentH = contentHeight()
		container.isHidden = contentH == 0
		container.frame = NSRect(
			x: Self.pad, y: Self.pad + composerH + Self.gap, width: innerWidth, height: contentH
		)
		visibleContent?.frame = container.bounds
		let s: CGFloat = 30
		stopButton.frame = NSRect(
			x: Self.pad + innerWidth - 8 - 52, y: Self.pad + (composerH - s) / 2, width: 52, height: s
		)
	}

	// MARK: render — decide what sits above the composer, then size the panel.

	private func render() {
		// A leading `/` opens the command menu over any mode; the rest is the filter.
		if composer.string.hasPrefix("/") {
			let matches = filteredCommands()
			if !matches.isEmpty {
				results.setItems(
					matches.map {
						ResultItem(id: $0.name, glyph: "/", label: $0.name, detail: $0.description)
					}
				)
				return present(.commands)
			}
			// Nothing matches — fall through to the underlying mode (the full grid, or chat);
			// Enter clears + chats.
		}
		if chatting { return present(.chat) }
		// A bare `/` with no command match shows the full springboard, not a filter.
		let query =
			composer.string.hasPrefix("/")
			? "" : composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
		if query.isEmpty {
			grid.setItems(apps, selectFirst: false)
			return present(.grid)
		}
		let matches = filtered(query)
		if matches.isEmpty {
			// No app matches — switch straight to chat (same-size surface) so Enter asks the agent.
			present(.chat)
		} else {
			grid.setItems(matches, selectFirst: true)
			present(.grid)
		}
	}

	private func present(_ content: Content) {
		self.content = content
		grid.isHidden = content != .grid
		results.isHidden = content != .commands
		webView.isHidden = content != .chat
		visibleContent =
			content == .grid ? grid : content == .commands ? results : content == .chat ? webView : nil
		// Arrows drive selection only when a pickable surface (grid or `/` menu) is up.
		composer.navActive = content == .grid || content == .commands
		sizePanel()
	}

	private func filtered(_ query: String) -> [CatalogApp] {
		let needle = query.lowercased()
		return apps.filter { $0.name.lowercased().contains(needle) }
	}

	// The `/` menu's matches: everything after the slash filters command names. An empty
	// filter (just `/`) lists them all.
	private func filteredCommands() -> [CatalogCommand] {
		let needle = composer.string.dropFirst().lowercased()
			.trimmingCharacters(in: .whitespacesAndNewlines)
		return needle.isEmpty ? commands : commands.filter { $0.name.lowercased().contains(needle) }
	}

	private func catalogArrived(_ apps: [CatalogApp]) {
		self.apps = apps
		if !chatting { render() } // refresh the current filter against the new catalog
	}

	// MARK: notifications — project quayd's notify channel onto the OS banner.

	// Suppress when the relevant surface is already in front (the panel is key and
	// visible — the transcript already shows the result); otherwise post a banner.
	private func notificationArrived(_ n: QuayNotification) {
		if panel.isVisible && panel.isKeyWindow { return }
		notifier.post(n)
	}

	// A banner click (or its Reconnect action): resolve the route. `chat` reveals the
	// transcript; `settings` opens the Settings mini-app in its own bundle (the `pane`
	// is a hint — the app has a single accounts pane today); anything else just summons
	// the launcher. `app` lands in a later slice.
	private func handleRoute(_ route: QuayNotification.Route?) {
		switch route?.kind {
		case "settings":
			openMiniApp(Self.settingsAppId)
		case "chat":
			show()
			enterChat(send: nil)
		default:
			show()
		}
	}

	// MARK: actions

	// Enter: in chat, send the draft; in the grid, launch the selected app; when the query
	// matches no app, ask the agent. Empty query + Enter is a no-op (nothing is selected).
	private func submit() {
		// In the `/` menu, Enter runs the selected command; with no match it's an escape
		// hatch — clear the input and fall into chat (enterChat clears the composer).
		if composer.string.hasPrefix("/") {
			if filteredCommands().isEmpty {
				enterChat(send: nil)
			} else {
				results.pickSelected()
			}
			return
		}
		let text = composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
		if chatting {
			if !text.isEmpty { sendChat(text) }
		} else if !text.isEmpty, filtered(text).isEmpty {
			// The query matches no app — ask the agent (chat is already on screen).
			enterChat(send: text)
		} else {
			// Launch the selected app (a no-op when nothing is selected, e.g. an empty query).
			grid.pickSelected()
		}
	}

	// Run a slash command: reveal the transcript and drive it over the chat webview's own
	// socket (window.quayCommand), so the authoritative transcript updates — `/new` clears
	// it, a skill shows its turn. Going through the webview (not the native catalog socket)
	// is what keeps the displayed conversation in sync.
	private func runCommand(_ name: String) {
		enterChat(send: nil)
		webView.evaluateJavaScript("window.quayCommand && window.quayCommand(\(jsString(name)))")
	}

	private func launch(_ id: String) {
		hide()
		openMiniApp(id)
	}

	// ⌘K: explicit switch between app-search and the conversation.
	private func toggleChat() {
		chatting.toggle()
		render()
		composer.focus()
	}

	// Reveal the warm transcript and (optionally) send an opening turn.
	private func enterChat(send: String?) {
		chatting = true
		composer.string = ""
		render()
		composer.focus()
		if let send { sendChat(send) }
	}

	private func sendChat(_ text: String) {
		composer.string = ""
		render()
		webView.evaluateJavaScript("window.quaySend && window.quaySend(\(jsString(text)))")
	}

	@objc private func stopStreaming() {
		webView.evaluateJavaScript("window.quayAbort && window.quayAbort()")
	}

	// MARK: quayd discovery → the transcript webview URL

	// The catalog socket is the single discovery path; when it (re)connects we point the
	// transcript webview at the live runtime. Reloading only on a real change keeps the
	// webview warm in steady state and heals it across a quayd restart (new port/token).
	private func useRuntime(_ port: Int, _ token: String) {
		if let r = chatRuntime, r.port == port, r.token == token { return }
		chatRuntime = (port, token)
		webView.load(URLRequest(url: chatURL(port: port, token: token)))
	}

	private func chatURL(port: Int, token: String) -> URL {
		var c = URLComponents()
		c.scheme = "http"
		c.host = "127.0.0.1"
		c.port = port
		c.path = "/launcher/chat"
		c.queryItems = [URLQueryItem(name: "token", value: token)]
		return c.url!
	}

	// JSON-encode a string into a JS string literal (quotes + escapes) for evaluateJavaScript.
	private func jsString(_ s: String) -> String {
		guard let data = try? JSONSerialization.data(withJSONObject: [s]),
			let arr = String(data: data, encoding: .utf8)
		else { return "''" }
		return String(arr.dropFirst().dropLast())
	}

	// MARK: panel lifecycle

	private func toggle() { panel.isVisible ? hide() : show() }

	private func show() {
		// Bottom-centre, raised off the Dock, on whichever screen the pointer is on. The
		// composer is pinned to the bottom edge; the panel grows upward as content gets taller.
		let screen =
			NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }
				?? NSScreen.main ?? NSScreen.screens.first
		if let v = screen?.visibleFrame {
			let x = v.midX - Self.panelWidth / 2
			let y = v.minY + 96
			panel.setFrame(
				NSRect(x: x, y: y, width: Self.panelWidth, height: Self.baseHeight), display: false
			)
		}
		NSApp.activate(ignoringOtherApps: true)
		panel.makeKeyAndOrderFront(nil)
		// Summon lands in app-search with a cleared composer; reconnect so the catalog and
		// the transcript runtime refresh even if quayd was killed while we were hidden.
		composer.string = ""
		chatting = false
		catalog.connect()
		render()
		composer.focus()
	}

	private func hide() { panel.orderOut(nil) }

	// Spotlight-style: dismiss when focus leaves the panel.
	func windowDidResignKey(_: Notification) { hide() }

	// MARK: bridge — the transcript webview's status (web → native).

	func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
		guard message.name == "status", let body = message.body as? [String: Any] else { return }
		let streaming = body["isStreaming"] as? Bool ?? false
		stopButton.isHidden = !streaming
		layoutSubviews()
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

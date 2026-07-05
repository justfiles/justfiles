import Cocoa

// The native composer: an NSTextView that auto-grows with its text between MIN and MAX
// (then scrolls), replacing the CSS `field-sizing` textarea the web launcher used. It
// owns the keyboard — Enter submits, Shift+Enter inserts a newline, Esc/⌘K/↑/↓ bubble up
// to the launcher via closures. Styled to match the old translucent rounded textarea.
final class Composer: NSView {
	static let minHeight: CGFloat = 48
	static let maxHeight: CGFloat = 160
	private static let inset = NSSize(width: 16, height: 13)

	var onSubmit: (() -> Void)?
	var onEscape: (() -> Void)?
	var onToggleChat: (() -> Void)?
	var onArrow: ((_ dx: Int, _ dy: Int) -> Void)?
	var onChange: (() -> Void)?

	// When true (the grid or the `/` menu is up), the arrow keys drive selection; otherwise
	// they fall through to move the insertion point in the text as usual.
	var navActive = false

	private let scroll = NSScrollView()
	private let textView = KeyTextView()

	var string: String {
		get { textView.string }
		set {
			textView.string = newValue
			textView.needsDisplay = true
		}
	}

	override init(frame: NSRect) {
		super.init(frame: frame)
		wantsLayer = true
		layer?.cornerRadius = 14
		layer?.masksToBounds = true
		layer?.backgroundColor = NSColor(white: 1, alpha: 0.08).cgColor

		textView.isRichText = false
		textView.font = .systemFont(ofSize: 18)
		textView.textColor = .white
		textView.insertionPointColor = .white
		textView.drawsBackground = false
		textView.textContainerInset = Self.inset
		textView.minSize = NSSize(width: 0, height: 0)
		textView.maxSize = NSSize(
			width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude
		)
		textView.isVerticallyResizable = true
		textView.isHorizontallyResizable = false
		textView.autoresizingMask = [.width]
		textView.textContainer?.containerSize = NSSize(
			width: 0, height: CGFloat.greatestFiniteMagnitude
		)
		textView.textContainer?.widthTracksTextView = true
		textView.placeholder = "Search apps or message agent…"
		textView.onKey = { [weak self] in self?.handleKey($0) ?? false }
		textView.onChange = { [weak self] in self?.onChange?() }

		scroll.drawsBackground = false
		scroll.hasVerticalScroller = false
		scroll.documentView = textView
		scroll.autoresizingMask = [.width, .height]
		scroll.frame = bounds
		addSubview(scroll)
	}

	required init?(coder _: NSCoder) { fatalError() }

	// The height the composer wants for its current text, clamped to [MIN, MAX]. Above MAX
	// the NSScrollView takes over and the text scrolls. The layout pass must set our width
	// first, since wrapping (and thus line count) depends on it.
	var desiredHeight: CGFloat {
		guard let lm = textView.layoutManager, let tc = textView.textContainer else {
			return Self.minHeight
		}
		lm.ensureLayout(for: tc)
		let used = lm.usedRect(for: tc).height + Self.inset.height * 2
		return min(max(used, Self.minHeight), Self.maxHeight)
	}

	func focus() { window?.makeFirstResponder(textView) }

	private func handleKey(_ event: NSEvent) -> Bool {
		let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
		switch event.keyCode {
		case 53: // Esc
			onEscape?()
			return true
		case 36, 76: // Return / keypad Enter
			if mods.contains(.shift) { return false } // Shift+Enter → newline
			onSubmit?()
			return true
		case 126: // ↑
			if navActive { onArrow?(0, -1); return true }
			return false
		case 125: // ↓
			if navActive { onArrow?(0, 1); return true }
			return false
		case 123: // ←
			if navActive { onArrow?(-1, 0); return true }
			return false
		case 124: // →
			if navActive { onArrow?(1, 0); return true }
			return false
		case 40 where mods == .command: // ⌘K
			onToggleChat?()
			return true
		default:
			return false
		}
	}
}

// An NSTextView that routes keys through a closure (so the Composer can intercept
// Enter/Esc/⌘K/arrows) and paints a placeholder while empty.
final class KeyTextView: NSTextView {
	var onKey: ((NSEvent) -> Bool)?
	var onChange: (() -> Void)?
	var placeholder = ""

	override func keyDown(with event: NSEvent) {
		if onKey?(event) == true { return }
		super.keyDown(with: event)
	}

	override func didChangeText() {
		super.didChangeText()
		needsDisplay = true
		onChange?()
	}

	override func draw(_ dirtyRect: NSRect) {
		super.draw(dirtyRect)
		guard string.isEmpty, !placeholder.isEmpty else { return }
		// Match where the text would start: container inset + the container's default
		// 5px line-fragment padding.
		let origin = NSPoint(x: textContainerInset.width + 5, y: textContainerInset.height)
		placeholder.draw(
			at: origin,
			withAttributes: [
				.font: font ?? .systemFont(ofSize: 18),
				.foregroundColor: NSColor(white: 1, alpha: 0.4)
			]
		)
	}
}

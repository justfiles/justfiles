import Cocoa

// One pickable row: a stable `id` the picker dispatches on, a glyph, a label, and an
// optional dimmed detail (used by the `/` command menu to show each command's blurb).
struct ResultItem {
	let id: String
	let glyph: String
	let label: String
	var detail: String? = nil
	var icon: String? = nil
}

// The native results list: a vertical, scrollable stack of icon+label rows shown above
// the composer — app search matches and the `/` command menu both render through it. The
// best match sits at the BOTTOM (nearest the composer, mirroring the old column-reverse
// web layout); ↑ walks up the list. At most MAX_VISIBLE rows show before it caps and
// scrolls. Replaces launcher.js's app rows.
final class Results: NSView {
	static let rowHeight: CGFloat = 46
	static let rowGap: CGFloat = 4
	static let maxVisible = 7
	static let cap = rowHeight * CGFloat(maxVisible) + rowGap * CGFloat(maxVisible - 1)

	// Picked by id (an app id or a command name); the launcher routes by current mode.
	var onPick: ((String) -> Void)?

	private let scroll = NSScrollView()
	private let doc = FlippedView()
	private var rows: [Row] = []
	private var items: [ResultItem] = []
	private(set) var selectedIndex = 0

	override init(frame: NSRect) {
		super.init(frame: frame)
		scroll.drawsBackground = false
		scroll.hasVerticalScroller = false
		scroll.documentView = doc
		scroll.autoresizingMask = [.width, .height]
		scroll.frame = bounds
		addSubview(scroll)
	}

	required init?(coder _: NSCoder) { fatalError() }

	// The intrinsic content height of the current rows (uncapped) — the launcher caps it
	// against `Results.cap` when sizing the panel.
	var contentHeight: CGFloat {
		guard !rows.isEmpty else { return 0 }
		return CGFloat(rows.count) * Self.rowHeight + CGFloat(rows.count - 1) * Self.rowGap
	}

	func setItems(_ items: [ResultItem]) {
		self.items = items
		selectedIndex = min(selectedIndex, max(0, items.count - 1))
		rebuild()
	}

	// ↑/↓ within the list. index 0 (best) sits at the bottom, so ↑ increases the index.
	func move(up: Bool) {
		guard !items.isEmpty else { return }
		selectedIndex = max(0, min(items.count - 1, selectedIndex + (up ? 1 : -1)))
		applySelection()
		scrollSelectedIntoView()
	}

	func pickSelected() {
		guard selectedIndex < items.count else { return }
		onPick?(items[selectedIndex].id)
	}

	private func rebuild() {
		rows.forEach { $0.removeFromSuperview() }
		// Worst→best, top→bottom, so the best match lands adjacent to the composer.
		rows = items.enumerated().reversed().map { itemIndex, item in
			let row = Row(
				glyph: item.glyph, label: item.label, detail: item.detail, hint: false, icon: item.icon
			)
			row.onHover = { [weak self] in self?.select(itemIndex) }
			row.onClick = { [weak self] in self?.onPick?(item.id) }
			doc.addSubview(row)
			return row
		}
		applySelection()
		layoutRows()
		scrollSelectedIntoView()
	}

	private func select(_ index: Int) {
		guard index != selectedIndex else { return }
		selectedIndex = index
		applySelection()
	}

	private func applySelection() {
		// rows[] is in visual order (top first), so the best match (selectedIndex 0) is last.
		for (visual, row) in rows.enumerated() {
			row.selected = (items.count - 1 - visual) == selectedIndex
		}
	}

	private func layoutRows() {
		let width = scroll.contentSize.width
		doc.frame = NSRect(x: 0, y: 0, width: width, height: contentHeight)
		for (visual, row) in rows.enumerated() {
			let y = CGFloat(visual) * (Self.rowHeight + Self.rowGap)
			row.frame = NSRect(x: 0, y: y, width: width, height: Self.rowHeight)
		}
	}

	private func scrollSelectedIntoView() {
		let visual = items.count - 1 - selectedIndex
		guard visual >= 0, visual < rows.count else { return }
		rows[visual].scrollToVisible(rows[visual].bounds)
	}

	override func layout() {
		super.layout()
		layoutRows()
	}
}

// A single icon+label row, used both for app results and the agent hint. Selectable
// (keyboard/hover) and clickable; the rounded highlight matches the web `.result` look.
final class Row: NSView {
	var onHover: (() -> Void)?
	var onClick: (() -> Void)?

	var selected = false {
		didSet { layer?.backgroundColor = selected ? NSColor(white: 1, alpha: 0.1).cgColor : .clear }
	}

	func setLabel(_ s: String) { text.stringValue = s }

	private var tracking: NSTrackingArea?
	private let text = NSTextField(labelWithString: "")

	init(glyph: String, label: String, detail: String? = nil, hint: Bool, icon: String? = nil) {
		super.init(frame: NSRect(x: 0, y: 0, width: 320, height: Results.rowHeight))
		wantsLayer = true
		layer?.cornerRadius = 12

		if let image = icon.flatMap(imageFromDataURL) {
			let imageView = NSImageView(frame: NSRect(x: 12, y: (Results.rowHeight - 30) / 2, width: 30, height: 30))
			imageView.image = image
			imageView.imageScaling = .scaleProportionallyUpOrDown
			imageView.autoresizingMask = [.maxYMargin, .minYMargin]
			addSubview(imageView)
		} else {
			let glyphView = GlyphView(text: glyph, hint: hint)
			glyphView.frame = NSRect(x: 12, y: (Results.rowHeight - 30) / 2, width: 30, height: 30)
			glyphView.autoresizingMask = [.maxYMargin, .minYMargin]
			addSubview(glyphView)
		}

		let font = NSFont.systemFont(ofSize: 15)
		// A single-line label fills its frame from the top, so size it to one line height
		// and centre it vertically in the row (matching the glyph), rather than spanning
		// the full row height where the text would sit at the top.
		let lineH = ceil(font.ascender - font.descender + font.leading)
		// A command row shows its name bright and its blurb dimmed alongside; a plain row
		// (apps, hint) is just the label.
		if let detail, !detail.isEmpty {
			let s = NSMutableAttributedString(
				string: label, attributes: [.font: font, .foregroundColor: NSColor.white]
			)
			s.append(
				NSAttributedString(
					string: "  \(detail)",
					attributes: [.font: font, .foregroundColor: NSColor(white: 1, alpha: 0.5)]
				)
			)
			text.attributedStringValue = s
		} else {
			text.stringValue = label
		}
		text.font = font
		text.textColor = .white
		text.lineBreakMode = .byTruncatingTail
		text.alphaValue = hint ? 0.75 : 1
		text.frame = NSRect(x: 52, y: (Results.rowHeight - lineH) / 2, width: 260, height: lineH)
		text.autoresizingMask = [.width]
		text.cell?.usesSingleLineMode = true
		addSubview(text)
	}

	required init?(coder _: NSCoder) { fatalError() }

	override func mouseDown(with _: NSEvent) { onClick?() }
	override func mouseEntered(with _: NSEvent) { onHover?() }

	override func updateTrackingAreas() {
		super.updateTrackingAreas()
		if let tracking { removeTrackingArea(tracking) }
		let area = NSTrackingArea(
			rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
			owner: self, userInfo: nil
		)
		addTrackingArea(area)
		tracking = area
	}
}

private func imageFromDataURL(_ url: String) -> NSImage? {
	guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ",") else { return nil }
	let meta = url[..<comma]
	let body = url[url.index(after: comma)...]
	let data = meta.range(of: ";base64") != nil
		? Data(base64Encoded: String(body))
		: String(body).removingPercentEncoding?.data(using: .utf8)
	return data.flatMap(NSImage.init(data:))
}

// The rounded glyph square: a blue gradient for apps, a flat tint for the agent hint,
// with a centered letter/emoji.
final class GlyphView: NSView {
	init(text: String, hint: Bool) {
		super.init(frame: NSRect(x: 0, y: 0, width: 30, height: 30))
		if hint {
			let solid = CALayer()
			solid.backgroundColor = NSColor(white: 1, alpha: 0.12).cgColor
			layer = solid
		} else {
			let gradient = CAGradientLayer()
			gradient.colors = [
				NSColor(srgbRed: 0x0A / 255, green: 0x84 / 255, blue: 1, alpha: 1).cgColor,
				NSColor(srgbRed: 0, green: 0x40 / 255, blue: 0xA0 / 255, alpha: 1).cgColor
			]
			gradient.startPoint = CGPoint(x: 0, y: 1)
			gradient.endPoint = CGPoint(x: 1, y: 0)
			layer = gradient
		}
		layer?.cornerRadius = 8
		wantsLayer = true

		let letter = NSTextField(labelWithString: text)
		letter.font = .systemFont(ofSize: 15, weight: .bold)
		letter.textColor = hint
			? NSColor(srgbRed: 0xCD / 255, green: 0xB4 / 255, blue: 1, alpha: 1)
			: .white
		letter.alignment = .center
		letter.frame = NSRect(x: 0, y: (30 - 18) / 2, width: 30, height: 18)
		addSubview(letter)
	}

	required init?(coder _: NSCoder) { fatalError() }
}

// A top-left origin view so manual row layout reads naturally (y grows downward).
final class FlippedView: NSView {
	override var isFlipped: Bool { true }
}

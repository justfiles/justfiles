import Cocoa

// The launcher's app springboard: a scrollable grid of large icons with names beneath,
// shown above the composer (iPad-springboard style). On summon it lists every app with no
// selection; typing filters it and auto-selects the best match so Enter launches it.
// Arrows browse in 2-D; click or Enter picks. Replaces the vertical Results list for app
// search — Results now only backs the `/` command menu.
final class AppGrid: NSView {
	static let columns = 5
	static let cellHeight: CGFloat = 96
	static let iconSize: CGFloat = 56

	// Picked by app id; the launcher launches its real `.app` bundle.
	var onPick: ((String) -> Void)?

	private let scroll = NSScrollView()
	private let doc = FlippedView()
	private var cells: [GridCell] = []
	private var items: [CatalogApp] = []
	private(set) var selectedIndex = -1 // -1 = no selection (the unfiltered springboard)

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

	// `selectFirst`: highlight the best match (while filtering) vs. no selection (the full
	// catalog on summon, where nothing is pre-picked).
	func setItems(_ items: [CatalogApp], selectFirst: Bool) {
		self.items = items
		selectedIndex = selectFirst && !items.isEmpty ? 0 : -1
		rebuild()
	}

	// 2-D arrow movement: dx walks within a row, dy between rows. From no selection, any
	// arrow lands on the first cell.
	func move(dx: Int, dy: Int) {
		guard !items.isEmpty else { return }
		if selectedIndex < 0 {
			selectedIndex = 0
		} else {
			var i = selectedIndex
			if dx != 0 { i = max(0, min(items.count - 1, i + dx)) }
			if dy != 0 {
				let target = i + dy * Self.columns
				if target >= 0, target < items.count { i = target }
			}
			selectedIndex = i
		}
		applySelection()
		scrollSelectedIntoView()
	}

	func pickSelected() {
		guard selectedIndex >= 0, selectedIndex < items.count else { return }
		onPick?(items[selectedIndex].id)
	}

	// The intrinsic height of the current rows; the grid scrolls within the launcher's
	// fixed surface when it exceeds it.
	var contentHeight: CGFloat {
		let rows = (items.count + Self.columns - 1) / Self.columns
		return CGFloat(rows) * Self.cellHeight
	}

	private func rebuild() {
		cells.forEach { $0.removeFromSuperview() }
		cells = items.enumerated().map { index, app in
			let cell = GridCell(app: app)
			cell.onHover = { [weak self] in self?.select(index) }
			cell.onClick = { [weak self] in self?.onPick?(app.id) }
			doc.addSubview(cell)
			return cell
		}
		applySelection()
		layoutCells()
		scrollSelectedIntoView()
	}

	private func select(_ index: Int) {
		guard index != selectedIndex else { return }
		selectedIndex = index
		applySelection()
	}

	private func applySelection() {
		for (i, cell) in cells.enumerated() { cell.selected = i == selectedIndex }
	}

	private func layoutCells() {
		let cellW = scroll.contentSize.width / CGFloat(Self.columns)
		doc.frame = NSRect(x: 0, y: 0, width: scroll.contentSize.width, height: contentHeight)
		for (i, cell) in cells.enumerated() {
			cell.frame = NSRect(
				x: CGFloat(i % Self.columns) * cellW, y: CGFloat(i / Self.columns) * Self.cellHeight,
				width: cellW, height: Self.cellHeight
			)
		}
	}

	private func scrollSelectedIntoView() {
		guard selectedIndex >= 0, selectedIndex < cells.count else { return }
		cells[selectedIndex].scrollToVisible(cells[selectedIndex].bounds)
	}

	override func layout() {
		super.layout()
		layoutCells()
	}
}

// One springboard cell: a large rounded app icon with the name beneath. Selectable
// (keyboard/hover) and clickable; selection shows a soft rounded highlight behind it.
final class GridCell: NSView {
	var onHover: (() -> Void)?
	var onClick: (() -> Void)?

	var selected = false { didSet { highlight.isHidden = !selected } }

	override var isFlipped: Bool { true }

	private var tracking: NSTrackingArea?
	private let highlight = NSView()
	private let iconView: NSView
	private let label = NSTextField(labelWithString: "")

	init(app: CatalogApp) {
		// The app's rendered icon, or the blue gradient glyph square as a fallback.
		if let image = app.icon.flatMap(imageFromDataURL) {
			let v = NSImageView()
			v.image = image
			v.imageScaling = .scaleProportionallyUpOrDown
			v.wantsLayer = true
			v.layer?.cornerRadius = 12
			v.layer?.masksToBounds = true
			iconView = v
		} else {
			iconView = GlyphView(text: app.glyph, hint: false, size: AppGrid.iconSize)
		}
		super.init(frame: .zero)
		wantsLayer = true

		highlight.wantsLayer = true
		highlight.layer?.cornerRadius = 16
		highlight.layer?.backgroundColor = NSColor(white: 1, alpha: 0.1).cgColor
		highlight.isHidden = true
		addSubview(highlight)
		addSubview(iconView)

		label.stringValue = app.name
		label.font = .systemFont(ofSize: 12)
		label.textColor = .white
		label.alignment = .center
		label.lineBreakMode = .byTruncatingTail
		label.cell?.usesSingleLineMode = true
		addSubview(label)
	}

	required init?(coder _: NSCoder) { fatalError() }

	override func layout() {
		super.layout()
		let size = AppGrid.iconSize
		let top: CGFloat = 8
		iconView.frame = NSRect(x: (bounds.width - size) / 2, y: top, width: size, height: size)
		label.frame = NSRect(x: 4, y: top + size + 4, width: bounds.width - 8, height: 16)
		// A pill hugging the icon + name, a touch wider than the icon.
		let hw = size + 24
		highlight.frame = NSRect(x: (bounds.width - hw) / 2, y: 2, width: hw, height: bounds.height - 4)
	}

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

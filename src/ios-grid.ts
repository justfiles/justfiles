/**
 * Apple's App Icon Grid — the keyline grid iOS's stock icon artwork is drawn on.
 *
 * The geometry below is measured from Apple's own vector drawing of the grid
 * (WWDC 2017 session 822, "App Icon Design", slide 55) and normalised to this
 * app's 1024 × 1024 output. Apple drew it on a 960-unit square; every value here
 * is that drawing × 1024/960, snapped to the construction it was plainly built
 * from. No snap moves a line by more than 0.6px at 1024 (under 0.06%).
 *
 * The construction, in order:
 *
 *  1. The icon's squircle fills the canvas: a continuous-curvature superellipse
 *     (equivalent Lamé exponent ≈ 4.94 — the same shape usually described as a
 *     22.37% corner radius at 60% corner smoothing). Its straight edges run
 *     between 320 and 704, so a corner blend owns the outer 31.3% of each side.
 *  2. Both 45° diagonals of the bounding square are drawn.
 *  3. Each diagonal crosses the squircle 67.2 units in from its corner. Ruling a
 *     horizontal and a vertical through those crossings gives the four OUTER
 *     lines, and the circle inscribed in the 889.6-unit square they bound is the
 *     largest circle.
 *  4. The canvas is divided by the golden ratio the way Apple documents it —
 *     512 × 320 = 1.6 : 1 per quadrant — giving the four INNER lines at 320 and
 *     704. The circle inscribed in the 384-unit square they bound is the
 *     smallest circle; the circle circumscribing that same square is the middle
 *     one. That is where the grid's root-two ratio lives: middle ÷ small = √2.
 *  5. A horizontal and a vertical centre line finish it.
 *
 * All ten straight lines span the full bounding square, so their ends — and the
 * diagonals' — deliberately overshoot the squircle's rounded corners.
 */

export const IOS_GRID_SIZE = 1024
export const IOS_GRID_CENTER = IOS_GRID_SIZE / 2

/** Golden-ratio division: 512 × 320 per quadrant. */
export const IOS_GRID_INNER_INSET = 320
/** Where a 45° diagonal of the bounding square meets the squircle. */
export const IOS_GRID_OUTER_INSET = 67.2

/** The five distinct positions the horizontal and vertical rules sit at. */
export const IOS_GRID_OFFSETS = [
	IOS_GRID_OUTER_INSET,
	IOS_GRID_INNER_INSET,
	IOS_GRID_CENTER,
	IOS_GRID_SIZE - IOS_GRID_INNER_INSET,
	IOS_GRID_SIZE - IOS_GRID_OUTER_INSET
] as const

/** Concentric circles: inscribed in the inner square, around it, then inscribed in the outer square. */
export const IOS_GRID_RADII = [
	IOS_GRID_CENTER - IOS_GRID_INNER_INSET,
	(IOS_GRID_CENTER - IOS_GRID_INNER_INSET) * Math.SQRT2,
	IOS_GRID_CENTER - IOS_GRID_OUTER_INSET
] as const

/** Apple's squircle outline, traced from the same drawing. */
export const IOS_GRID_SQUIRCLE_PATH =
	'M 1023.99 320.32 C 1023.99 308.09 1024 295.86 1023.92 283.63 C 1023.86 273.32 1023.74 263.03 1023.46 252.73 C 1022.86 230.29 1021.53 207.66 1017.55 185.48 C 1013.5 162.95 1006.89 141.99 996.47 121.52 C 986.24 101.42 972.87 83.02 956.92 67.07 C 940.97 51.12 922.57 37.75 902.46 27.51 C 882.01 17.1 861.05 10.49 838.54 6.45 C 816.34 2.46 793.71 1.14 771.27 0.53 C 760.97 0.25 750.67 0.13 740.36 0.07 C 728.13 -0.01 715.9 0 703.67 0 L 320.32 0 C 308.09 0 295.86 -0.01 283.63 0.07 C 273.32 0.13 263.03 0.25 252.73 0.53 C 230.28 1.14 207.65 2.46 185.45 6.45 C 162.94 10.49 141.98 17.1 121.53 27.51 C 101.42 37.75 83.02 51.12 67.07 67.07 C 51.12 83.02 37.75 101.42 27.52 121.52 C 17.1 141.99 10.49 162.95 6.44 185.48 C 2.46 207.66 1.14 230.29 0.53 252.73 C 0.25 263.03 0.13 273.32 0.07 283.63 C -0.01 295.86 0 308.09 0 320.32 L 0 703.67 C 0 715.9 -0.01 728.13 0.07 740.36 C 0.13 750.66 0.25 760.96 0.53 771.26 C 1.14 793.7 2.46 816.33 6.44 838.51 C 10.49 861.04 17.1 882 27.52 902.47 C 37.75 922.57 51.12 940.97 67.07 956.92 C 83.02 972.87 101.42 986.24 121.53 996.48 C 141.98 1006.89 162.94 1013.5 185.45 1017.54 C 207.65 1021.53 230.28 1022.86 252.73 1023.46 C 263.03 1023.74 273.32 1023.86 283.63 1023.92 C 295.86 1024 308.09 1023.99 320.32 1023.99 L 703.67 1023.99 C 715.9 1023.99 728.13 1024 740.36 1023.92 C 750.67 1023.86 760.97 1023.74 771.27 1023.46 C 793.71 1022.86 816.34 1021.53 838.54 1017.54 C 861.05 1013.5 882.01 1006.89 902.46 996.48 C 922.57 986.24 940.97 972.87 956.92 956.92 C 972.87 940.97 986.24 922.57 996.47 902.47 C 1006.89 882 1013.5 861.04 1017.55 838.51 C 1021.53 816.33 1022.86 793.7 1023.46 771.26 C 1023.74 760.96 1023.86 750.66 1023.92 740.36 C 1024 728.13 1023.99 715.9 1023.99 703.67 L 1023.99 320.32 Z'

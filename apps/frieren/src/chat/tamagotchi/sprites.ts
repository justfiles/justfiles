// Prop draw helpers for the tamagotchi scene.
// Props are palette-driven so they recolor per biome.

import type { Palette } from './palettes'

export type Ctx = CanvasRenderingContext2D

// ---------- props ----------

export type PropKind = 'tree' | 'bush' | 'rock' | 'mushroom' | 'flower' | 'pillar'

export interface Prop {
	kind: PropKind
	x: number
	y: number
	variant: number
}

export function drawTree(ctx: Ctx, p: Palette, x: number, y: number, s: number, variant: number) {
	const h = 14 + variant * 2
	const w = 10 + variant
	ctx.fillStyle = p.trunk
	ctx.fillRect(
		Math.round(x - s),
		Math.round(y - 3 * s),
		Math.max(1, Math.round(2 * s)),
		Math.max(1, Math.round(3 * s))
	)
	ctx.fillStyle = p.leafDark
	ctx.beginPath()
	ctx.moveTo(x, y - h * s)
	ctx.lineTo(x - w * s * 0.5, y - 3 * s)
	ctx.lineTo(x + w * s * 0.5, y - 3 * s)
	ctx.closePath()
	ctx.fill()
	ctx.fillStyle = p.leaf
	ctx.beginPath()
	ctx.moveTo(x - s, y - (h - 2) * s)
	ctx.lineTo(x - w * s * 0.45, y - 4 * s)
	ctx.lineTo(x + w * s * 0.35, y - 4 * s)
	ctx.closePath()
	ctx.fill()
}

export function drawBush(ctx: Ctx, p: Palette, x: number, y: number, s: number, variant: number) {
	ctx.fillStyle = p.leafDark
	for (let i = -1; i <= 1; i++) {
		ctx.beginPath()
		ctx.ellipse(x + i * 2 * s, y - 2 * s, (3 + variant) * s, 2 * s, 0, 0, Math.PI * 2)
		ctx.fill()
	}
	ctx.fillStyle = p.leaf
	ctx.beginPath()
	ctx.ellipse(x, y - 3 * s, (2 + variant) * s, 1.5 * s, 0, 0, Math.PI * 2)
	ctx.fill()
}

export function drawRock(ctx: Ctx, p: Palette, x: number, y: number, s: number, variant: number) {
	ctx.fillStyle = p.rock
	ctx.beginPath()
	ctx.ellipse(x, y - 1.5 * s, (3 + variant) * s, 2 * s, 0, 0, Math.PI * 2)
	ctx.fill()
	ctx.fillStyle = 'rgba(255,255,255,0.18)'
	ctx.beginPath()
	ctx.ellipse(x - s, y - 2.5 * s, (1 + variant) * s, 0.6 * s, 0, 0, Math.PI * 2)
	ctx.fill()
}

export function drawMushroom(
	ctx: Ctx,
	_p: Palette,
	x: number,
	y: number,
	s: number,
	variant: number
) {
	ctx.fillStyle = '#f6f0d8'
	ctx.fillRect(x - 0.5 * s, y - 2 * s, s, 2 * s)
	ctx.fillStyle = variant % 2 ? '#c23a3a' : '#d4772a'
	ctx.beginPath()
	ctx.ellipse(x, y - 2 * s, 1.5 * s, 0.9 * s, 0, Math.PI, 0)
	ctx.fill()
	ctx.fillStyle = 'rgba(255,255,255,0.7)'
	ctx.fillRect(x - 0.4 * s, y - 2.4 * s, 0.4 * s, 0.4 * s)
}

export function drawFlower(ctx: Ctx, p: Palette, x: number, y: number, s: number) {
	ctx.fillStyle = p.leaf
	ctx.fillRect(x, y - 2 * s, Math.max(1, 0.3 * s), 2 * s)
	ctx.fillStyle = p.flower
	ctx.fillRect(x - 0.5 * s, y - 2.5 * s, s, s)
}

export function drawPillar(ctx: Ctx, p: Palette, x: number, y: number, s: number, variant: number) {
	const h = (6 + variant) * s
	ctx.fillStyle = p.rock
	ctx.fillRect(x - s, y - h, 2 * s, h)
	ctx.fillStyle = 'rgba(0,0,0,0.3)'
	ctx.fillRect(x + 0.5 * s, y - h, 0.5 * s, h)
	ctx.fillStyle = p.rock
	ctx.fillRect(x - 1.4 * s, y - h - s, 2.8 * s, s)
}

export function drawProp(ctx: Ctx, p: Palette, prop: Prop, s: number) {
	switch (prop.kind) {
		case 'tree':
			return drawTree(ctx, p, prop.x, prop.y, s, prop.variant)
		case 'bush':
			return drawBush(ctx, p, prop.x, prop.y, s, prop.variant)
		case 'rock':
			return drawRock(ctx, p, prop.x, prop.y, s, prop.variant)
		case 'mushroom':
			return drawMushroom(ctx, p, prop.x, prop.y, s, prop.variant)
		case 'flower':
			return drawFlower(ctx, p, prop.x, prop.y, s)
		case 'pillar':
			return drawPillar(ctx, p, prop.x, prop.y, s, prop.variant)
	}
}

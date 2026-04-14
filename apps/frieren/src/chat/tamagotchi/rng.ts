// Seeded RNG + 1D value noise with fbm. Zero deps.

export function mulberry32(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export type Noise1D = (x: number, octaves?: number, lacunarity?: number, gain?: number) => number

export function makeNoise1D(rand: () => number): Noise1D {
	const perm = new Float32Array(256)
	for (let i = 0; i < 256; i++) perm[i] = rand()
	const smooth = (t: number) => t * t * (3 - 2 * t)
	const raw = (x: number) => {
		const i = Math.floor(x)
		const f = x - i
		const a = perm[i & 255]
		const b = perm[(i + 1) & 255]
		return a + (b - a) * smooth(f)
	}
	return (x, octaves = 4, lacunarity = 2, gain = 0.5) => {
		let amp = 1
		let freq = 1
		let sum = 0
		let norm = 0
		for (let o = 0; o < octaves; o++) {
			sum += amp * raw(x * freq)
			norm += amp
			amp *= gain
			freq *= lacunarity
		}
		return sum / norm
	}
}

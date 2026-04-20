type PreparedQueryPiece = {
	value: string
	valueLower: string
}

type PreparedQuery = {
	normalized: string
	normalizedLower: string
	pieces: PreparedQueryPiece[]
	containsPathSeparator: boolean
}

type FuzzyScore = {
	score: number
	positions: number[]
}

type CandidateScore = {
	score: number
	labelMatchCount: number
	matchDistance: number
	basenameLength: number
	depth: number
	pathLength: number
}

export type FuzzyPathItem = {
	id: string
	path: string
	active: number
	updated_at: string
}

const NO_SCORE: FuzzyScore = { score: 0, positions: [] }
const EXACT_PATH_SCORE = 1 << 20
const LABEL_PREFIX_SCORE = 1 << 17
const LABEL_SCORE = 1 << 16

export function searchPaths<T extends FuzzyPathItem>(
	items: readonly T[],
	rawQuery: string,
	options?: { limit?: number }
): T[] {
	const query = prepareQuery(rawQuery)
	if (!query) return []

	const limit = options?.limit ?? 100
	const scored = items
		.filter((item) => item.active !== 0)
		.map((item) => {
			const score = scoreCandidate(item.path, query)
			return score ? { item, score } : null
		})
		.filter((entry): entry is { item: T; score: CandidateScore } => entry !== null)
		.sort((left, right) => compareScores(left.score, right.score, left.item.path, right.item.path))

	return scored.slice(0, limit).map((entry) => entry.item)
}

function compareScores(
	left: CandidateScore,
	right: CandidateScore,
	leftPath: string,
	rightPath: string
): number {
	if (left.score !== right.score) return right.score - left.score
	if (left.labelMatchCount !== right.labelMatchCount) {
		return right.labelMatchCount - left.labelMatchCount
	}
	if (left.matchDistance !== right.matchDistance) {
		return left.matchDistance - right.matchDistance
	}
	if (left.basenameLength !== right.basenameLength) {
		return left.basenameLength - right.basenameLength
	}
	if (left.depth !== right.depth) return left.depth - right.depth
	if (left.pathLength !== right.pathLength) return left.pathLength - right.pathLength
	return leftPath.localeCompare(rightPath)
}

function prepareQuery(rawQuery: string): PreparedQuery | null {
	const normalized = normalizePathLike(rawQuery)
	if (!normalized) return null

	const pieces = normalized
		.split(/\s+/)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => ({
			value,
			valueLower: value.toLowerCase()
		}))

	if (pieces.length === 0) return null

	return {
		normalized,
		normalizedLower: normalized.toLowerCase(),
		pieces,
		containsPathSeparator: normalized.includes('/')
	}
}

function scoreCandidate(path: string, query: PreparedQuery): CandidateScore | null {
	const normalizedPath = normalizePathLike(path)
	if (!normalizedPath) return null

	const basename = basenameOf(normalizedPath)
	const dirname = dirnameOf(normalizedPath)

	if (normalizedPath.toLowerCase() === query.normalizedLower) {
		return {
			score: EXACT_PATH_SCORE,
			labelMatchCount: 1,
			matchDistance: basename.length,
			basenameLength: basename.length,
			depth: pathDepth(normalizedPath),
			pathLength: normalizedPath.length
		}
	}

	let totalScore = 0
	let labelMatchCount = 0
	let matchDistance = 0

	for (const piece of query.pieces) {
		const pieceScore = scoreQueryPiece(
			normalizedPath,
			basename,
			dirname,
			piece,
			query.containsPathSeparator
		)
		if (!pieceScore) return null
		totalScore += pieceScore.score
		labelMatchCount += pieceScore.labelMatchCount
		matchDistance += pieceScore.matchDistance
	}

	return {
		score: totalScore,
		labelMatchCount,
		matchDistance,
		basenameLength: basename.length,
		depth: pathDepth(normalizedPath),
		pathLength: normalizedPath.length
	}
}

function scoreQueryPiece(
	path: string,
	basename: string,
	dirname: string,
	piece: PreparedQueryPiece,
	containsPathSeparator: boolean
): Pick<CandidateScore, 'score' | 'labelMatchCount' | 'matchDistance'> | null {
	const preferLabelMatches = !containsPathSeparator && dirname.length > 0

	if (preferLabelMatches || dirname.length === 0) {
		const labelScore = scoreFuzzy(basename, piece.value, piece.valueLower)
		if (labelScore.score > 0) {
			const prefixBoost = basename.toLowerCase().startsWith(piece.valueLower)
				? LABEL_PREFIX_SCORE + Math.round((piece.value.length / basename.length) * 100)
				: LABEL_SCORE
			return {
				score: prefixBoost + labelScore.score,
				labelMatchCount: 1,
				matchDistance: matchSpan(labelScore.positions)
			}
		}
	}

	const pathScore = scoreFuzzy(path, piece.value, piece.valueLower)
	if (pathScore.score === 0) return null

	return {
		score: pathScore.score,
		labelMatchCount: 0,
		matchDistance: matchSpan(pathScore.positions)
	}
}

function scoreFuzzy(target: string, query: string, queryLower: string): FuzzyScore {
	if (!target || !query) return NO_SCORE
	if (target.length < query.length) return NO_SCORE

	const targetLower = target.toLowerCase()
	const queryLength = query.length
	const targetLength = target.length
	const scores = new Array<number>(queryLength * targetLength).fill(0)
	const matches = new Array<number>(queryLength * targetLength).fill(0)

	for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
		const rowOffset = queryIndex * targetLength
		const prevRowOffset = rowOffset - targetLength
		const queryChar = query[queryIndex]
		const queryLowerChar = queryLower[queryIndex]

		for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
			const currentIndex = rowOffset + targetIndex
			const leftScore = targetIndex > 0 ? scores[currentIndex - 1] : 0
			const diagIndex = prevRowOffset + targetIndex - 1
			const diagScore = queryIndex > 0 && targetIndex > 0 ? scores[diagIndex] : 0
			const sequenceLength = queryIndex > 0 && targetIndex > 0 ? matches[diagIndex] : 0

			let charScore = 0
			if (!(queryIndex > 0 && diagScore === 0)) {
				charScore = computeCharScore(
					queryChar,
					queryLowerChar,
					target,
					targetLower,
					targetIndex,
					sequenceLength
				)
			}

			if (charScore > 0) {
				matches[currentIndex] = sequenceLength + 1
				scores[currentIndex] = diagScore + charScore
			} else {
				matches[currentIndex] = 0
				scores[currentIndex] = leftScore
			}
		}
	}

	const finalScore = scores[queryLength * targetLength - 1] ?? 0
	if (finalScore === 0) return NO_SCORE

	const positions: number[] = []
	let queryIndex = queryLength - 1
	let targetIndex = targetLength - 1

	while (queryIndex >= 0 && targetIndex >= 0) {
		const currentIndex = queryIndex * targetLength + targetIndex
		if (matches[currentIndex] === 0) {
			targetIndex--
			continue
		}
		positions.push(targetIndex)
		queryIndex--
		targetIndex--
	}

	if (positions.length !== queryLength) return NO_SCORE
	return { score: finalScore, positions: positions.reverse() }
}

function computeCharScore(
	queryChar: string,
	queryLowerChar: string,
	target: string,
	targetLower: string,
	targetIndex: number,
	sequenceLength: number
): number {
	if (queryLowerChar !== targetLower[targetIndex]) return 0

	let score = 1

	if (sequenceLength > 0) {
		score += Math.min(sequenceLength, 3) * 6
		score += Math.max(0, sequenceLength - 3) * 3
	}

	if (queryChar === target[targetIndex]) score += 1

	if (targetIndex === 0) {
		score += 8
	} else {
		const separatorBonus = scoreSeparator(target.charCodeAt(targetIndex - 1))
		if (separatorBonus > 0) {
			score += separatorBonus
		} else if (isUpper(target.charCodeAt(targetIndex)) && sequenceLength === 0) {
			score += 2
		}
	}

	return score
}

function scoreSeparator(charCode: number): number {
	switch (charCode) {
		case 47:
		case 92:
			return 5
		case 95:
		case 45:
		case 46:
		case 32:
		case 39:
		case 34:
		case 58:
			return 4
		default:
			return 0
	}
}

function isUpper(charCode: number): boolean {
	return charCode >= 65 && charCode <= 90
}

function matchSpan(positions: number[]): number {
	if (positions.length === 0) return Number.MAX_SAFE_INTEGER
	return positions[positions.length - 1] - positions[0] + 1
}

function normalizePathLike(value: string): string {
	return value
		.trim()
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}

function basenameOf(path: string): string {
	const index = path.lastIndexOf('/')
	return index === -1 ? path : path.slice(index + 1)
}

function dirnameOf(path: string): string {
	const index = path.lastIndexOf('/')
	return index === -1 ? '' : path.slice(0, index)
}

function pathDepth(path: string): number {
	return path.split('/').filter(Boolean).length
}

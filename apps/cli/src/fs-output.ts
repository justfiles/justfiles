import { FileType, type Stat } from '@justfiles/fs/types'

function typeName(type: FileType): 'file' | 'directory' | 'symlink' {
	switch (type) {
		case FileType.Directory:
			return 'directory'
		case FileType.Symlink:
			return 'symlink'
		default:
			return 'file'
	}
}

function typeChar(type: FileType): '-' | 'd' | 'l' {
	switch (type) {
		case FileType.Directory:
			return 'd'
		case FileType.Symlink:
			return 'l'
		default:
			return '-'
	}
}

function isoFromNs(ns: bigint): string {
	return new Date(Number(ns / 1_000_000n)).toISOString()
}

export function statToJson(path: string, stat: Stat) {
	return {
		path,
		ino: stat.ino,
		type: typeName(stat.type),
		size: stat.size.toString(),
		mtimeNs: stat.mtimeNs.toString(),
		ctimeNs: stat.ctimeNs.toString(),
		contentHash: stat.contentHash ?? null
	}
}

export function formatStat(path: string, stat: Stat): string[] {
	return [
		`path: ${path}`,
		`type: ${typeName(stat.type)}`,
		`ino: ${stat.ino}`,
		`size: ${stat.size.toString()}`,
		`mtime: ${isoFromNs(stat.mtimeNs)}`,
		`ctime: ${isoFromNs(stat.ctimeNs)}`,
		`content-hash: ${stat.contentHash ?? '(none)'}`
	]
}

export function formatLongEntry(name: string, stat: Stat): string {
	return `${typeChar(stat.type)}\t${stat.size.toString()}\t${isoFromNs(stat.mtimeNs)}\t${name}`
}

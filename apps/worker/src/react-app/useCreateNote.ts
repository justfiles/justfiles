import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useSidebarActions } from './SidebarContext'
import { noteFilenameFromName } from './notePath'
import { useVolume } from './useVolume'

export function useCreateNote() {
	const navigate = useNavigate()
	const { volume } = useVolume()
	const { upsertEntry } = useSidebarActions()

	return useCallback(async () => {
		let attempt = 1
		let targetPath = `/${noteFilenameFromName('untitled')}`

		while (await volume.exists(targetPath)) {
			attempt += 1
			targetPath = `/${noteFilenameFromName(`untitled ${attempt}`)}`
		}

		await volume.writeFile(targetPath, new Uint8Array())

		const stat = await volume.stat(targetPath)
		const entry = {
			id: stat.ino,
			title: null,
			path: targetPath.slice(1),
			updated_at: new Date().toISOString(),
			tags: [],
			active: 1
		}

		upsertEntry(entry)
		await navigate({ to: '/memory/$id', params: { id: entry.id } })

		return entry
	}, [navigate, upsertEntry, volume])
}

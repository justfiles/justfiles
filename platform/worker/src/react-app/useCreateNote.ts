import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { noteFilenameFromName } from './notePath'
import { useSidebarActions } from './SidebarContext'
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
		await navigate({
			to: '/files/$id',
			params: { id: entry.id },
			viewTransition: true,
			state: { isNew: true }
		})

		return entry
	}, [navigate, upsertEntry, volume])
}

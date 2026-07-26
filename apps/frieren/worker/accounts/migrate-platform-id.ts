// One-off (Kodama rebrand): the platform AI account moved from the retired `spud` id to
// the internal `frieren` one. Runs before `ensureAccount` seeds the new id, so a returning
// user keeps their AI toggle and active-AI selection. Delete this file and its call site
// once no live volume carries the old id.

import { renameAccount } from '@justfiles/app/capabilities/accounts/host'
import type { Volume } from '@justfiles/fs'

export function migratePlatformAccountId(volume: Volume): Promise<void> {
	return renameAccount(volume, 'spud', { accountId: 'frieren', providerId: 'frieren' })
}

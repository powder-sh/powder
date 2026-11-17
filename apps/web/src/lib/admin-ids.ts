// Admin user ids from env (comma-separated POWDER_ADMIN_USER_IDS). Single
// authority shared by access.ts and the backup scheduler.
const ADMIN_USER_IDS = new Set(
	(process.env.POWDER_ADMIN_USER_IDS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean),
)

// First-run admin (see first-run.ts): held on globalThis so every bundle in this
// process sees it. Restored at boot from powder_meta while POWDER_ADMIN_USER_IDS is
// empty (with a WARN); persist it in POWDER_ADMIN_USER_IDS.
const g = globalThis as { __powderBootstrapAdmins?: Set<string> }
function bootstrapAdmins(): Set<string> {
	if (!g.__powderBootstrapAdmins) g.__powderBootstrapAdmins = new Set()
	return g.__powderBootstrapAdmins
}

export function registerBootstrapAdmin(id: string): void {
	bootstrapAdmins().add(id)
}

export function adminIdsConfigured(): boolean {
	return ADMIN_USER_IDS.size > 0
}

// True when the id comes from POWDER_ADMIN_USER_IDS, not only from the
// first-run bootstrap (which a restart forgets). Used by the setup checklist.
export function isPersistedAdminId(id: string): boolean {
	return ADMIN_USER_IDS.has(id)
}

export function isAdminUserId(id: string): boolean {
	return ADMIN_USER_IDS.has(id) || bootstrapAdmins().has(id)
}

/** Every current admin id: POWDER_ADMIN_USER_IDS order, then first-run bootstrap ones. */
function adminUserIds(): string[] {
	return [...new Set([...ADMIN_USER_IDS, ...bootstrapAdmins()])]
}

/** whose stored GitHub token background jobs may use. Only current
 *  admins: the preferred user (the app owner) first when they are one, then the
 *  other admins. A removed or non-admin user's token is never picked. */
export function adminTokenCandidates(preferUserId: string | null | undefined): string[] {
	const admins = adminUserIds()
	const first = preferUserId && admins.includes(preferUserId) ? [preferUserId] : []
	return [...new Set([...first, ...admins])]
}

import { getCurrentUser, singleTenantBlocks } from '@/lib/access'
import { redirect } from 'next/navigation'

// Server-component gate. The dashboard layout redirects signed-out visitors,
// but layout and page render in parallel, so a page that queries the DB must
// run this first, before any query, or its data can stream to an anonymous
// request. Same rule as the API routes (requireUser): a session or token, and
// an admin id (single-tenant).
export async function requirePageUser() {
	const u = await getCurrentUser()
	if (!u || singleTenantBlocks(u.id)) redirect('/login')
	return u
}

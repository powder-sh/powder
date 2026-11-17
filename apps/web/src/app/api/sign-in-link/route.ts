// Where the docs header's "Sign in" points, or null. The docs are static (built
// once), and whether to link the login depends on POWDER_SITE_HOST, a runtime
// setting, so the header asks here after load (components/sign-in-link.tsx).
// Not on the site allowlist (lib/hosts.ts): a split site host answers 404 and
// the link stays hidden, so the site never points at the dashboard.

import { publicSignInHref } from '@/lib/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
	return Response.json({ href: publicSignInHref() }, { headers: { 'cache-control': 'no-store' } })
}

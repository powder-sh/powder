import {
	SETUP_COOKIE,
	SETUP_COOKIE_MAX_AGE_SEC,
	firstRunOpen,
	setupTokenMatches,
} from '@/lib/first-run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/setup/token (form from /setup). On a fresh install the first
// GitHub login only becomes admin when it carries the setup cookie this sets.
// The token is printed only in the server log (lib/first-run.ts). Relative
// Location headers: request.url is the container address behind the proxy.
function back(location: string, setCookie?: string): Response {
	const headers = new Headers({ location, 'cache-control': 'no-store' })
	if (setCookie) headers.append('set-cookie', setCookie)
	return new Response(null, { status: 303, headers })
}

export async function POST(req: Request): Promise<Response> {
	if (!(await firstRunOpen())) return back('/setup?state=done')
	let token = ''
	try {
		const form = await req.formData()
		token = String(form.get('token') ?? '').trim()
	} catch {
		return back('/setup?state=bad')
	}
	if (!setupTokenMatches(token)) return back('/setup?state=bad')
	const secure = (process.env.BETTER_AUTH_URL ?? '').startsWith('https:') ? '; Secure' : ''
	const cookie = `${SETUP_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SETUP_COOKIE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure}`
	return back('/login?setup=ok', cookie)
}

import { toNextJsHandler } from 'better-auth/next-js'
import { auth } from '@/lib/auth'
import { isRemovedAuthPath } from '@/lib/auth-paths'

export const runtime = 'nodejs'

const handler = toNextJsHandler(auth)

// Signup does not exist. better-auth would answer /sign-up/* with a 400; answer
// 404 like any other removed route. Endpoints the UI does not use are off in
// better-auth itself (disabledPaths, lib/auth-paths.ts); /reset-password/:token
// is caught here, disabledPaths matches exact paths only.
export function isSignupPath(pathname: string): boolean {
	return pathname.startsWith('/api/auth/sign-up')
}

const notFound = () => Response.json({ error: 'not_found' }, { status: 404 })
const removed = (req: Request) => isRemovedAuthPath(new URL(req.url).pathname)

export const GET = (req: Request) => (removed(req) ? notFound() : handler.GET(req))
export const POST = (req: Request) => (removed(req) ? notFound() : handler.POST(req))

'use client'

import { authClient } from '@/lib/auth-client'
import { posthogKey } from '@/lib/posthog-config'
import posthog from 'posthog-js'
import { PostHogProvider as PHProvider } from 'posthog-js/react'
import { useEffect, useRef } from 'react'

// Analytics is off unless NEXT_PUBLIC_POSTHOG_KEY and NEXT_PUBLIC_POSTHOG_HOST are both
// set at build time (the host is where the /ingest rewrite sends events).
const POSTHOG_KEY = posthogKey(process.env.NEXT_PUBLIC_POSTHOG_KEY, process.env.NEXT_PUBLIC_POSTHOG_HOST)

// Identifies the signed-in user and resets on sign-out. Watching the session
// covers every sign-out path.
function PostHogIdentify() {
	const { data: session } = authClient.useSession()
	const user = session?.user
	const identified = useRef(false)

	useEffect(() => {
		if (!POSTHOG_KEY) return
		if (user) {
			posthog.identify(user.id, { email: user.email, name: user.name })
			identified.current = true
		} else if (identified.current) {
			posthog.reset()
			identified.current = false
		}
	}, [user])

	return null
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		if (!POSTHOG_KEY) return
		posthog.init(POSTHOG_KEY, {
			api_host: '/ingest',
			ui_host: process.env.NEXT_PUBLIC_POSTHOG_UI_HOST || 'https://eu.posthog.com',
			defaults: '2025-05-24',
			persistence: 'memory',
			person_profiles: 'identified_only',
			ip: false,
			// no session replay, in code (not only a project setting). The
			// dashboard shows webhook URLs, deploy keys, env values and fresh API tokens;
			// the root layout cannot tell the dashboard host from the site host without
			// going dynamic, so replay is off on both.
			disable_session_recording: true,
			capture_exceptions: true,
		})
	}, [])

	if (!POSTHOG_KEY) return <>{children}</>

	return (
		<PHProvider client={posthog}>
			<PostHogIdentify />
			{children}
		</PHProvider>
	)
}

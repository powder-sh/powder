'use client'

import { cn } from '@/lib/cn'
import posthog from 'posthog-js'

export function ContactEmailLink({ className }: { className?: string }) {
	return (
		<a
			href="mailto:hello@powder.sh"
			className={cn('underline underline-offset-2 hover:text-foreground', className)}
			onClick={() => posthog.capture('contact_email_clicked', { location: 'footer' })}
		>
			hello@powder.sh
		</a>
	)
}

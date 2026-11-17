import { cn } from '@/lib/cn'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'

// Every dashboard page starts with this: optional back link, title,
// one-line description, actions on the right (stacked under on phones).
export function PageHeader({
	title,
	description,
	actions,
	back,
	meta,
	className,
}: {
	title: React.ReactNode
	description?: React.ReactNode
	actions?: React.ReactNode
	back?: { href: string; label: string }
	meta?: React.ReactNode
	className?: string
}) {
	return (
		<header className={cn('space-y-3', className)}>
			{back && <BackLink href={back.href}>{back.label}</BackLink>}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
				<div className="min-w-0 space-y-1">
					<h1 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight">
						{title}
					</h1>
					{description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
					{meta && (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-sm text-muted-foreground">
							{meta}
						</div>
					)}
				</div>
				{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
			</div>
		</header>
	)
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<Link
			href={href}
			className="-ml-1 inline-flex min-h-10 items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-0"
		>
			<ChevronLeft className="h-3.5 w-3.5" aria-hidden />
			{children}
		</Link>
	)
}

// Section heading inside a page: small, semibold, optional trailing actions.
export function SectionHeader({
	title,
	description,
	actions,
	className,
}: {
	title: React.ReactNode
	description?: React.ReactNode
	actions?: React.ReactNode
	className?: string
}) {
	return (
		<div className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
			<div className="min-w-0">
				<h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">{title}</h2>
				{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	)
}

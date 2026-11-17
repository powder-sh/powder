import { requirePageUser } from '@/lib/page-gate'
import { PageHeader } from '@/components/ui/page-header'
import { Bell, BookOpen, ChevronRight, KeyRound, Plug, Users } from 'lucide-react'
import Link from 'next/link'
import { SetupChecklistToggle } from './setup-checklist-toggle'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
	const isAdmin = (await requirePageUser()).isAdmin
	const items = [
		{
			href: '/integrations',
			icon: Plug,
			title: 'integrations',
			body: 'GitHub and other accounts powder can use on your behalf',
		},
		{
			href: '/settings/tokens',
			icon: KeyRound,
			title: 'API tokens',
			body: 'tokens for the powder API, CI and AI agents (MCP)',
		},
		{
			href: '/settings/notifications',
			icon: Bell,
			title: 'notifications',
			body: 'webhooks and email for deploy, uptime, backup and cron alerts',
		},
		{
			href: '/docs',
			icon: BookOpen,
			title: 'docs',
			body: 'quickstart, env vars, domains, backups',
		},
		...(isAdmin
			? [
					{
						href: '/admin/users',
						icon: Users,
						title: 'users',
						body: 'who can sign in to this powder',
					},
				]
			: []),
	]
	return (
		<div className="space-y-6">
			<title>settings · powder</title>
			<PageHeader title="settings" />
			<ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card">
				{items.map((it) => (
					<li key={it.href}>
						<Link
							href={it.href}
							className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-accent/40"
						>
							<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
								<it.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
							</span>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">{it.title}</div>
								<div className="text-xs text-muted-foreground">{it.body}</div>
							</div>
							<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						</Link>
					</li>
				))}
			</ul>
			{isAdmin && <SetupChecklistToggle />}
		</div>
	)
}

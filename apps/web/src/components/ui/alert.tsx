import { cn } from '@/lib/cn'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'

const tones = {
	info: { frame: 'border-info/30 bg-info/5', icon: Info, iconCls: 'text-info' },
	success: { frame: 'border-success/30 bg-success/5', icon: CheckCircle2, iconCls: 'text-success' },
	warning: { frame: 'border-warning/35 bg-warning/5', icon: AlertTriangle, iconCls: 'text-warning' },
	destructive: {
		frame: 'border-destructive/35 bg-destructive/5',
		icon: XCircle,
		iconCls: 'text-destructive',
	},
} as const

// Inline notice. Title says what happened; children say what to do.
export function Alert({
	tone = 'info',
	title,
	children,
	action,
	className,
}: {
	tone?: keyof typeof tones
	title?: React.ReactNode
	children?: React.ReactNode
	action?: React.ReactNode
	className?: string
}) {
	const t = tones[tone]
	const Icon = t.icon
	return (
		<div
			role={tone === 'destructive' ? 'alert' : 'status'}
			className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', t.frame, className)}
		>
			<Icon className={cn('mt-0.5 h-4 w-4 shrink-0', t.iconCls)} aria-hidden />
			<div className="min-w-0 flex-1 space-y-1">
				{title && <p className="font-medium text-foreground">{title}</p>}
				{children && <div className="break-words text-muted-foreground">{children}</div>}
			</div>
			{action && <div className="shrink-0 self-center">{action}</div>}
		</div>
	)
}

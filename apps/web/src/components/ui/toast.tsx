'use client'

import { createContext, useCallback, useContext, useState } from 'react'
import { CheckCircle, Info, X, XCircle } from 'lucide-react'

export type ToastKind = 'error' | 'success' | 'info'

interface Toast {
	id: number
	kind: ToastKind
	message: string
}

interface Ctx {
	push: (kind: ToastKind, message: string) => void
	error: (message: string) => void
	success: (message: string) => void
}

const ToastContext = createContext<Ctx | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([])

	const push = useCallback((kind: ToastKind, message: string) => {
		const id = Date.now() + Math.random()
		setToasts((t) => [...t, { id, kind, message }])
		setTimeout(
			() => {
				setToasts((t) => t.filter((x) => x.id !== id))
			},
			kind === 'error' ? 8000 : 5000,
		)
	}, [])

	const value: Ctx = {
		push,
		error: (m) => push('error', m),
		success: (m) => push('success', m),
	}

	return (
		<ToastContext.Provider value={value}>
			{children}
			<div
				aria-live="polite"
				className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:w-96"
			>
				{toasts.map((t) => (
					<div
						key={t.id}
						role={t.kind === 'error' ? 'alert' : 'status'}
						className="pointer-events-auto flex w-full animate-enter items-start gap-2.5 rounded-lg border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-popover"
					>
						{t.kind === 'error' ? (
							<XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
						) : t.kind === 'success' ? (
							<CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
						) : (
							<Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
						)}
						<span className="min-w-0 flex-1 break-words">{t.message}</span>
						<button
							type="button"
							aria-label="dismiss"
							onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
							className="-m-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
						>
							<X className="h-3.5 w-3.5" aria-hidden />
						</button>
					</div>
				))}
			</div>
		</ToastContext.Provider>
	)
}

export function useToast(): Ctx {
	const ctx = useContext(ToastContext)
	if (!ctx) throw new Error('useToast must be inside ToastProvider')
	return ctx
}

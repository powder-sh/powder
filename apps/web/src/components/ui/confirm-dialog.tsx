'use client'

import { useEffect, useRef } from 'react'
import { Button } from './button'
import { useModalFocus } from './use-modal-focus'

interface ConfirmDialogProps {
	open: boolean
	title: string
	description?: React.ReactNode
	confirmLabel?: string
	cancelLabel?: string
	danger?: boolean
	loading?: boolean
	/** the confirm button is disabled and Enter does nothing (a typed confirmation not matched yet) */
	confirmDisabled?: boolean
	onConfirm: () => void
	onClose: () => void
}

export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel = 'confirm',
	cancelLabel = 'cancel',
	danger = false,
	loading = false,
	confirmDisabled = false,
	onConfirm,
	onClose,
}: ConfirmDialogProps) {
	const panelRef = useRef<HTMLDivElement>(null)
	// Focus moves in on open (a [data-autofocus] field in the description, else
	// cancel), Tab stays inside, and focus returns to the trigger on close.
	useModalFocus(open, panelRef)

	useEffect(() => {
		if (!open) return
		function onKey(e: KeyboardEvent) {
			// While the action runs the dialog stays: cancel is disabled too.
			if (e.key === 'Escape') {
				if (!loading) onClose()
			} else if (e.key === 'Enter') {
				if (loading || confirmDisabled) return
				const tag = (e.target as HTMLElement | null)?.tagName
				if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return
				onConfirm()
			}
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [open, loading, confirmDisabled, onClose, onConfirm])

	if (!open) return null

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click; Esc is handled on document
		<div
			className="fixed inset-0 z-50 flex items-end justify-center p-4 backdrop-blur-sm sm:items-center"
			onClick={() => {
				if (!loading) onClose()
			}}
			// biome-ignore lint/a11y/useSemanticElements: <dialog> top-layer styling differs; this is a managed modal
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
		>
			<div className="absolute inset-0 bg-background/70" />
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the backdrop click */}
			<div
				ref={panelRef}
				onClick={(e) => e.stopPropagation()}
				className="relative w-full max-w-md animate-enter rounded-xl border border-border bg-popover text-popover-foreground shadow-popover"
			>
				<div className="px-5 pt-5">
					<h2 id="confirm-dialog-title" className="text-base font-semibold tracking-tight">
						{title}
					</h2>
				</div>
				{description && (
					<div className="px-5 pt-2 text-sm leading-relaxed text-muted-foreground">
						{description}
					</div>
				)}
				<div className="mt-5 flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
					<Button variant="outline" size="sm" onClick={onClose} disabled={loading} data-modal-cancel>
						{cancelLabel}
					</Button>
					<Button
						variant={danger ? 'destructive' : 'default'}
						size="sm"
						onClick={onConfirm}
						loading={loading}
						disabled={confirmDisabled}
					>
						{confirmLabel}
					</Button>
				</div>
			</div>
		</div>
	)
}

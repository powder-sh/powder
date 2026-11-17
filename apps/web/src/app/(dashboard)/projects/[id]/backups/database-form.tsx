'use client'

// Which postgres database the app's backups dump: PATCH /api/projects/[id] with
// hasPostgres and the backupDb* fields (lib/app-settings.ts validates them, an
// admin browser session only). The password is write-only: the API says whether
// one is stored and never returns it.

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldRow, Input } from '@/components/ui/input'
import { uiErrorCopy } from '@/lib/ui-error-copy'
import { useState } from 'react'

export interface BackupDatabase {
	container: string | null
	host: string | null
	name: string | null
	user: string | null
	passwordSet: boolean
	defaultContainer: string
	canEdit: boolean
}

export function BackupDatabaseCard({
	projectId,
	database,
	turnOn,
	onSaved,
}: {
	projectId: string
	database: BackupDatabase
	/** The app has no postgres database yet: saving also turns backups on. */
	turnOn: boolean
	onSaved: () => void | Promise<void>
}) {
	const [container, setContainer] = useState(database.container ?? '')
	const [host, setHost] = useState(database.host ?? '')
	const [name, setName] = useState(database.name ?? '')
	const [user, setUser] = useState(database.user ?? '')
	const [password, setPassword] = useState('')
	const [saving, setSaving] = useState<'save' | 'clear' | null>(null)
	const [error, setError] = useState<string | null>(null)

	const dirty =
		turnOn ||
		container.trim() !== (database.container ?? '') ||
		host.trim() !== (database.host ?? '') ||
		name.trim() !== (database.name ?? '') ||
		user.trim() !== (database.user ?? '') ||
		password !== ''

	const send = async (kind: 'save' | 'clear', body: Record<string, unknown>) => {
		setSaving(kind)
		setError(null)
		try {
			const res = await fetch(`/api/projects/${projectId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			if (!res.ok) {
				const d = (await res.json().catch(() => ({}))) as { error?: string }
				setError(d.error ? uiErrorCopy(d.error) : `save failed (${res.status})`)
				return
			}
			setPassword('')
			await onSaved()
		} catch {
			setError('save failed')
		} finally {
			setSaving(null)
		}
	}

	if (!database.canEdit) {
		return (
			<p className="text-sm text-muted-foreground">
				an admin sets which database this app backs up, on this tab.
			</p>
		)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>database</CardTitle>
				<CardDescription className="mt-0.5">
					the postgres database backups dump and restores load into. empty fields use the defaults:
					container <code className="font-mono text-foreground">{database.defaultContainer}</code>,
					database and user <code className="font-mono text-foreground">app</code>.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault()
						void send('save', {
							...(turnOn ? { hasPostgres: true } : {}),
							backupDbContainer: container,
							backupDbHost: host,
							backupDbName: name,
							backupDbUser: user,
							...(password ? { backupDbPassword: password } : {}),
						})
					}}
				>
					<FieldRow hint="a host (name or IP, optionally :port, as the app server reaches it) replaces the container: pg_dump connects over TCP, needs the password and restore is not available.">
						<Input
							label="container"
							placeholder={database.defaultContainer}
							value={container}
							onChange={(e) => setContainer(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
						/>
						<Input
							label="host"
							placeholder="none"
							value={host}
							onChange={(e) => setHost(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
						/>
					</FieldRow>
					<FieldRow
						error={error}
						action={
							<Button type="submit" variant="outline" disabled={!dirty || saving !== null}>
								{saving === 'save' ? 'saving…' : turnOn ? 'turn on backups' : 'save'}
							</Button>
						}
					>
						<Input
							label="database"
							placeholder="app"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
						/>
						<Input
							label="user"
							placeholder="app"
							value={user}
							onChange={(e) => setUser(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
						/>
						<Input
							label="password"
							type="password"
							placeholder={database.passwordSet ? 'stored, empty keeps it' : 'none'}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="new-password"
						/>
					</FieldRow>
					{database.passwordSet && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={saving !== null}
							onClick={() => void send('clear', { backupDbPassword: null })}
						>
							{saving === 'clear' ? 'removing…' : 'remove the stored password'}
						</Button>
					)}
				</form>
			</CardContent>
		</Card>
	)
}

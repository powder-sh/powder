// Words and tones for a server row's status (servers.status), shared by the
// servers list and the server page.

import type { StatusTone } from '@/components/ui/status'

type ServerStatus = 'pending' | 'connected' | 'unreachable'

const SERVER_STATUS: Record<ServerStatus, { label: string; tone: StatusTone }> = {
	connected: { label: 'online', tone: 'success' },
	pending: { label: 'not contacted yet', tone: 'warning' },
	unreachable: { label: 'unreachable', tone: 'destructive' },
}

export function serverStatus(s: string): { label: string; tone: StatusTone } {
	return SERVER_STATUS[s as ServerStatus] ?? { label: s, tone: 'neutral' }
}

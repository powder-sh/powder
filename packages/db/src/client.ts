import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index'

const connectionString =
	process.env.DATABASE_URL ?? 'postgres://powder:powder@localhost:5433/powder'

// Pool hardening. The deploy-claim loop and the cron scheduler both run forever
// on long-lived timers, and each does its work through a single `await` against
// this pool. With the library defaults (max:10, no timeouts) a single leaked or
// hung connection can starve the pool — and then the NEXT query doesn't error,
// it queues client-side FOREVER (postgres.js never sends it, so it's invisible
// in pg_stat_activity). A hung await is not caught by try/finally, so the loop
// wedges silently. These settings make that impossible to persist:
//   - statement_timeout: server kills any single query running > 2m, freeing
//     the connection. No query in this app legitimately runs that long (backups
//     dump via SSH on the app server, not through this pool).
//   - idle_in_transaction_session_timeout: server kills a transaction that
//     BEGAN but then sat idle > 1m — i.e. exactly the leaked/hung transaction
//     that caused the original deploy-claim wedge. A healthy db.transaction()
//     runs its statements back-to-back in ms and never trips this.
//   - max_lifetime / idle_timeout: recycle connections so a zombie is reclaimed
//     even if the timeouts above somehow miss it.
//   - max: headroom for a multi-server deploy storm running concurrently with
//     the claim transaction (web + worker are separate processes / separate
//     pools, so 20 each is well under postgres max_connections).
const client = postgres(connectionString, {
	max: 20,
	idle_timeout: 30, // seconds — close a connection idle this long
	max_lifetime: 60 * 30, // seconds — recycle every connection every 30 min
	connect_timeout: 30, // seconds — bound the initial TCP/auth handshake
	connection: {
		statement_timeout: 120_000, // ms — server-side kill of any query > 2m
		idle_in_transaction_session_timeout: 60_000, // ms — kill leaked/hung txns
	},
})
export const db = drizzle(client, { schema })
export type Database = typeof db

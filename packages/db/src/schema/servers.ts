import { sql } from 'drizzle-orm'
import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const serverKind = pgEnum('server_kind', ['compose', 'raw-docker'])
export const serverStatus = pgEnum('server_status', ['pending', 'connected', 'unreachable'])

export const servers = pgTable(
	'servers',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		host: text('host').notNull(),
		sshUser: text('ssh_user').notNull().default('root'),
		sshPort: text('ssh_port').notNull().default('22'),
		kind: serverKind('kind').notNull().default('compose'),
		status: serverStatus('status').notNull().default('pending'),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
		lastError: text('last_error'),
		ownerUserId: text('owner_user_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		// Per-server backup destination. When set, apps on this server upload
		// backups here instead of the global BACKUP_S3_* env vars. Lets each tenant
		// (e.g. a client org) own its own bucket on its own storage account, even when
		// powder itself is running for someone else. Encryption passphrase stays
		// global (POWDER_BACKUP_KEY env var) so restore process is uniform.
		backupS3Endpoint: text('backup_s3_endpoint'),
		backupS3Region: text('backup_s3_region'),
		backupS3Bucket: text('backup_s3_bucket'),
		backupS3AccessKeyIdEncrypted: text('backup_s3_access_key_id_encrypted'),
		backupS3SecretAccessKeyEncrypted: text('backup_s3_secret_access_key_encrypted'),
		// Dedicated builder host (0034). When set, deploys for this server's apps
		// build on the builder and the image is streamed to the target; NULL =
		// build locally on the target server.
		buildHost: text('build_host'),
		// Routing mode (0040). 'nginx' = host/containerised nginx + host port;
		// 'nginx-container' = nginx runs in a container; 'traefik' = apps routed by
		// Traefik labels. tlsMode only matters for
		// traefik: 'acme' = HTTP-01 certresolver, 'origin-cert' = Cloudflare origin
		// cert from the default store (no certresolver label).
		proxy: text('proxy')
			.$type<'nginx' | 'nginx-container' | 'traefik'>()
			.notNull()
			.default('nginx'),
		tlsMode: text('tls_mode').$type<'acme' | 'origin-cert'>().notNull().default('acme'),
		// Base domain for default app hosts (0041), e.g. 'apps.example.com' gives
		// <app>.apps.example.com. NULL = no default host; needs wildcard DNS
		// *.<base_domain> to the server.
		baseDomain: text('base_domain'),
		// Public IPv4 a custom domain's A record must point at (0046). NULL = use the
		// server's host when it is an IPv4 literal, else resolve the host name.
		ingressIp: text('ingress_ip'),
		// Last server check (0060): green, the proxy it ran against, and when.
		checkGreen: boolean('check_green'),
		checkProxy: text('check_proxy').$type<'nginx' | 'nginx-container' | 'traefik'>(),
		checkedAt: timestamp('checked_at', { withTimezone: true }),
	},
	(t) => ({
		hostUnique: uniqueIndex('servers_host_unique').on(sql`lower(${t.host})`),
	}),
)

export type Server = typeof servers.$inferSelect
export type NewServer = typeof servers.$inferInsert

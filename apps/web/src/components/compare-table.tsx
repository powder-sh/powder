// Landing-page comparison. The cells stay factual and uncolored; only the powder
// column is marked, so a reader finds the product this page is about.
// Every cell is checked against that project's own docs; keep the date in
// CHECKED in step when a row changes.

const PRODUCTS = ['Vercel', 'Coolify', 'Kamal', 'powder'] as const

// Phones list powder first, then the others in table order.
const MOBILE_ORDER = [3, 0, 1, 2] as const

// Phones show these rows first; the rest open under "show all".
const MOBILE_KEY_ROWS = [0, 4, 7] as const

const CHECKED = 'November 2026'

const ROWS: { label: string; values: [string, string, string, string] }[] = [
	{
		label: 'Where apps and builds run',
		values: [
			"Vercel's cloud, builds in Vercel VMs",
			'Your servers; builds on target or build server',
			'Your servers; builds locally or on a remote builder, pushes to a registry',
			'Your servers; builds on target or builder',
		],
	},
	{
		label: 'How it reaches servers',
		values: [
			'No servers to reach',
			'SSH from the Coolify control plane',
			'SSH from your laptop or CI',
			'SSH from the powder control plane',
		],
	},
	{
		label: 'Containers and proxy already on the server',
		values: [
			'Not applicable',
			'Fresh server advised; Traefik, Caddy or none',
			'kamal-proxy takes ports 80 and 443',
			'Adopts running compose apps; reads nginx, Traefik',
		],
	},
	{
		label: 'Where env vars live',
		values: [
			'Encrypted at Vercel, per environment',
			'In Coolify, applied on redeploy',
			'Local secrets files, env file on host',
			'Encrypted in powder DB; never overwrites hand edits',
		],
	},
	{
		label: 'New version fails its health check',
		values: [
			'Build gates promotion; rollback is manual',
			'Old container stays; deploy marked failed',
			'Traffic moves only after /up returns 200',
			'Old container stays; auto-rollback after swap',
		],
	},
	{
		label: 'Database backups',
		values: [
			'Up to the Marketplace provider',
			'Scheduled database backups, local or S3',
			'Not built in',
			'Postgres only, encrypted, to S3',
		],
	},
	{
		label: 'Coding-agent access',
		values: [
			'Official remote MCP, OAuth login',
			'REST API with team-scoped tokens',
			'CLI and config files',
			'Remote MCP, path-scoped API tokens',
		],
	},
	{
		label: 'Who it is built for',
		values: [
			'Teams with roles, hosted accounts',
			'Teams with roles; self-host or Cloud',
			'Anyone with SSH and a config file',
			'One operator per install',
		],
	},
	{
		label: 'License',
		values: ['Proprietary hosted service', 'Apache-2.0', 'MIT', 'AGPL-3.0-or-later'],
	},
]

export function CompareTable() {
	return (
		<>
			{/* Phones: the key questions as cards, the rest behind "show all" (no JS needed). */}
			<div className="md:hidden">
				<ul className="space-y-3" aria-label="comparison, key rows">
					{MOBILE_KEY_ROWS.map((i) => (
						<MobileRow key={ROWS[i]?.label} row={ROWS[i] as (typeof ROWS)[number]} />
					))}
				</ul>
				<details className="group mt-3">
					<summary className="flex h-11 cursor-pointer list-none items-center justify-center rounded-xl border border-border text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
						<span className="group-open:hidden">show all {ROWS.length} rows</span>
						<span className="hidden group-open:inline">show fewer</span>
					</summary>
					<ul className="mt-3 space-y-3" aria-label="comparison, other rows">
						{ROWS.filter((_, i) => !(MOBILE_KEY_ROWS as readonly number[]).includes(i)).map((r) => (
							<MobileRow key={r.label} row={r} />
						))}
					</ul>
				</details>
			</div>

			<div className="hidden overflow-hidden rounded-[14px] border border-border bg-card md:block">
				<table className="w-full table-fixed border-collapse text-left text-sm">
					<caption className="sr-only">Vercel, Coolify, Kamal and powder compared</caption>
					<colgroup>
						<col className="w-[20%]" />
						<col />
						<col />
						<col />
						<col />
					</colgroup>
					<thead>
						<tr className="border-b border-border-strong">
							<th scope="col" className="px-4 py-3.5 lg:px-5">
								<span className="sr-only">Question</span>
							</th>
							{PRODUCTS.map((p) => (
								<th
									key={p}
									scope="col"
									className={
										p === 'powder'
											? 'border-x border-signal/25 bg-signal/[0.06] px-4 py-3.5 font-semibold text-signal lg:px-5'
											: 'px-4 py-3.5 font-semibold lg:px-5'
									}
								>
									{p}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{ROWS.map((r) => (
							<tr key={r.label} className="border-b border-border last:border-0">
								<th
									scope="row"
									className="px-4 py-3.5 align-top text-xs font-medium leading-snug text-muted-foreground lg:px-5"
								>
									{r.label}
								</th>
								{r.values.map((v, i) => (
									<td
										key={PRODUCTS[i]}
										className={
											PRODUCTS[i] === 'powder'
												? 'border-x border-signal/25 bg-signal/[0.06] px-4 py-3.5 align-top leading-snug lg:px-5'
												: 'px-4 py-3.5 align-top leading-snug lg:px-5'
										}
									>
										{v}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="mt-4 text-center font-mono text-xs text-muted-foreground">
				Checked against each project&apos;s docs, {CHECKED}.
			</p>
		</>
	)
}

function MobileRow({ row: r }: { row: (typeof ROWS)[number] }) {
	return (
		<li className="rounded-xl border border-border bg-card p-4">
			<h3 className="text-sm font-semibold tracking-tight">{r.label}</h3>
			<dl className="mt-3 divide-y divide-border">
				{MOBILE_ORDER.map((i) => (
					<div
						key={PRODUCTS[i]}
						className={
							PRODUCTS[i] === 'powder'
								? '-mx-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 rounded-md bg-signal/[0.06] px-2 py-2'
								: 'grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 py-2'
						}
					>
						<dt
							className={
								PRODUCTS[i] === 'powder'
									? 'text-xs font-semibold text-signal'
									: 'text-xs font-medium text-muted-foreground'
							}
						>
							{PRODUCTS[i]}
						</dt>
						<dd className="text-sm leading-snug">{r.values[i]}</dd>
					</div>
				))}
			</dl>
		</li>
	)
}

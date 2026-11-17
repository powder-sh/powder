// One corpus of credential shapes for the secret-egress guards. Every entry has
// a `secret` (the substring that must never leave powder) and a `line` that
// carries it the way a build log, git error or env dump would. Token bodies are
// assembled from parts so no scanner mistakes this file for a real leak.

const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const alnum = (seed: string, n: number) => rep(`${seed}Q7wE2rT9yU4iO1pA6sD3fG8hJ5kL0zX`, n)

export interface SecretFixture {
	id: string
	secret: string
	line: string
}

const GHS = `ghs_${alnum('Gs', 36)}`
const GHP = `ghp_${alnum('Gp', 36)}`
const GHO = `gho_${alnum('Go', 36)}`
const PAT = `github_${'pat'}_${alnum('Pt', 22)}_${alnum('Px', 59)}`
const AKIA = `AKIA${rep('IOSFODNN7EXAMPLQ', 16)}`
const AWS_SECRET = rep('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYzz', 40)
const SK = `sk-proj-${alnum('Sk', 40)}`
const GLPAT = `glpat-${alnum('Gl', 20)}`
const NPM = `npm_${alnum('Np', 36)}`
const AIZA = `AIza${alnum('Ai', 35)}`
const SLACK_TOKEN = alnum('Sl', 24)
const DISCORD_TOKEN = `${alnum('Dc', 30)}-${alnum('Dd', 37)}`
const BEARER = alnum('Br', 40)
const PEM_BODY = `MIIEpAIBAAKCAQEA${alnum('Pm', 48)}`
const HEX40 = rep('0123456789abcdef', 40)
const AZURE_PAT = rep('a1b2c3d4e5f6g7h8j9k0m1n2p3q4r5s6t7u8v9w0x1y2z3', 52)
const HEX40B = rep('fedcba9876543210', 40)
const INGEST = alnum('Ig', 32)
const PEM_OPEN_BODY = `b3BlbnNzaC1rZXktdjEAAAAA${alnum('Po', 40)}`

export const SECRET_FIXTURES: SecretFixture[] = [
	{
		id: 'fx01',
		secret: 'Tk9pQx7LmZ2vR4',
		line: 'Cloning https://deployer:Tk9pQx7LmZ2vR4@git.example.com/acme/web.git',
	},
	{
		id: 'fx02',
		secret: GHS,
		line: `remote: https://x-access-token:${GHS}@github.com/acme/web.git`,
	},
	{ id: 'fx03', secret: GHP, line: `using token ${GHP} for the registry` },
	{ id: 'fx04', secret: GHO, line: `oauth ${GHO} refreshed` },
	{ id: 'fx05', secret: PAT, line: `export GH=${PAT}` },
	{
		id: 'fx06',
		secret: 'Pg5ecretPw77',
		line: 'DATABASE_URL=postgres://app:Pg5ecretPw77@app-db:5432/app',
	},
	{
		id: 'fx07',
		secret: 'My5qlPw-x91',
		line: 'connecting to mysql://root:My5qlPw-x91@mysql:3306/shop',
	},
	{ id: 'fx08', secret: 'R3disPw99zz', line: 'cache at redis://:R3disPw99zz@cache:6379/0' },
	{ id: 'fx09', secret: AKIA, line: `aws key id ${AKIA}` },
	{ id: 'fx10', secret: AWS_SECRET, line: `aws_secret_access_key = ${AWS_SECRET}` },
	{ id: 'fx12', secret: SK, line: `openai client sk ${SK}` },
	{ id: 'fx13', secret: GLPAT, line: `gitlab ${GLPAT}` },
	{ id: 'fx14', secret: NPM, line: `//registry.npmjs.org/:_authToken ${NPM}` },
	{ id: 'fx15', secret: AIZA, line: `maps key ${AIZA}` },
	{
		id: 'fx16',
		secret: SLACK_TOKEN,
		line: `posting to https://hooks.slack.com/services/T0AB12CD3/B0EF45GH6/${SLACK_TOKEN}`,
	},
	{
		id: 'fx17',
		secret: DISCORD_TOKEN,
		line: `webhook https://discord.com/api/webhooks/123456789012345678/${DISCORD_TOKEN}`,
	},
	{
		id: 'fx18',
		secret: BEARER,
		line: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com`,
	},
	{ id: 'fx19', secret: 'St41pe5ecretVal', line: 'STRIPE_SECRET=St41pe5ecretVal' },
	{ id: 'fx20', secret: 'Gh70kenVal123', line: 'GH_TOKEN=Gh70kenVal123' },
	{ id: 'fx21', secret: 'ApiK3yVal456', line: 'MAPS_API_KEY=ApiK3yVal456' },
	{ id: 'fx22', secret: 'DbPa55wordVal', line: 'DB_PASSWORD=DbPa55wordVal' },
	{
		id: 'fx23',
		secret: PEM_BODY,
		line: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
	},
	{
		// A truncated key (no END line), e.g. a capped log: body lines still masked.
		id: 'fx24',
		secret: PEM_OPEN_BODY,
		line: `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_OPEN_BODY}`,
	},
	{
		// Classic 40-hex PAT as a bare username (git clone error).
		id: 'fx25',
		secret: HEX40,
		line: `fatal: unable to access 'https://${HEX40}@github.com/acme/web/'`,
	},
	{
		// Azure DevOps 52-char PAT as a bare username.
		id: 'fx26',
		secret: AZURE_PAT,
		line: `git fetch https://${AZURE_PAT}@dev.azure.com/acme/web/_git/web`,
	},
	{
		// Dockerfile RUN line shape seen in real deploy logs: token as bare userinfo.
		id: 'fx27',
		secret: HEX40B,
		line: `RUN git config --global url."https://${HEX40B}@github.com/".insteadOf "https://github.com/"`,
	},
	{
		// powder's own ingest log line.
		id: 'fx28',
		secret: INGEST,
		line: `[ingest-auth] rejected request token=${INGEST} from 10.0.0.5`,
	},
	{
		id: 'fx29',
		secret: 'hunter two three four',
		line: `DATABASE_PASSWORD='hunter two three four'`,
	},
	{
		id: 'fx30',
		secret: 'my long secret phrase',
		line: '{"db_password": "my long secret phrase", "authorId": "u_1"}',
	},
]

/** Every fixture secret contained in `text` (ids). */
export function leakedIn(text: string): string[] {
	return SECRET_FIXTURES.filter((f) => text.includes(f.secret)).map((f) => f.id)
}

/** A realistic deploy log carrying every fixture, each line tagged with its id. */
export function corpusLog(): string {
	return SECRET_FIXTURES.map((f) => `[${f.id}] ${f.line}`).join('\n')
}

export const FX = { GHS, GHP, PEM_BODY, SK, BEARER }

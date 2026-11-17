import { SITE_URL } from '@/lib/site'

// Ready-to-paste prompts for coding agents (Claude Code, Cursor, ...). Every
// command, path and setting below is documented in content/docs; keep them in
// step when the docs change. Placeholders are in <angle brackets>.
const doc = (slug: string, hash = '') => `${SITE_URL}/docs/${slug}${hash}`

export const AGENT_PROMPTS: { id: string; title: string; prompt: string }[] = [
	{
		id: 'install',
		title: 'Install powder on a fresh server',
		prompt: `Install powder, the self-hosted deploy platform (https://github.com/powder-sh/powder), on my Linux server <ssh target>. Follow ${doc('quickstart')} step by step and don't add steps it does not list.

- Check the server first: root, at least 2 GB of RAM, git, curl and openssl. An existing Docker needs docker compose 2.24 or newer. If Docker is missing, bin/install.sh offers to install it: ask me before you say yes.
- Ask me for the dashboard hostname (its DNS points at this server, ports 80 and 443 open). Before the install I create a GitHub OAuth app (github.com/settings/developers, New OAuth App) with homepage https://<host> and callback URL https://<host>/api/auth/callback/github. Never invent the host or the OAuth values.
- Clone the latest release tag: \`git clone --branch <latest tag> https://github.com/powder-sh/powder /opt/apps/powder/src\`. Then run \`sudo bin/install.sh\` in that directory. It asks for the host, the client id and the client secret; I type the secret myself (it is not echoed). Without a terminal I can type into, pass \`--host <host> --github-client-id <id>\` and I put the secret in a file (mode 600) for \`--github-client-secret-file <file>\`, then delete it; add \`--yes\` only if I agreed to install Docker.
- Read the setup token from the log: \`docker logs powder 2>&1 | grep 'setup token'\`. Tell me to open https://<host>/setup, enter it and continue with GitHub in the same browser.
- The log then prints \`[first-run] ... POWDER_ADMIN_USER_IDS=<id>\`. Run \`sudo bin/install.sh --set-admin <id>\`.

Stop at the first failing step and show me the error. Don't print secrets. When it is up, remind me to back up /opt/apps/powder.env: without its POWDER_ENCRYPTION_KEY the encrypted data cannot be read.`,
	},
	{
		id: 'app-ready',
		title: 'Make my app powder-ready',
		prompt: `Make this repository ready to deploy with powder (${doc('deploys')}). Powder clones the repo onto my server and builds the Dockerfile there. It writes the compose file on the server itself, so the repo needs no compose file and no CI workflow.

- Add or fix a Dockerfile at the repo root: multi-stage, builds the app, starts it listening on one port. For Next.js set output: 'standalone' in next.config.
- Add a .dockerignore that keeps .git, node_modules, .env files and local data out of the build context.
- Add a health endpoint such as GET /api/health that answers 200 fast, with no auth, no Host header requirement and no calls to external services.
- Read all config from environment variables at runtime. NEXT_PUBLIC_* values are baked in at build time, so pass those as Dockerfile build args.
- If the app has database migrations, set LABEL powder.release.cmd="<migrate command>" in the Dockerfile. Powder runs it once from the new image before the swap.
- Never commit secrets.

If Docker is available here, build the image once to check it. Then tell me the internal port and the health path.`,
	},
	{
		id: 'server',
		title: 'Connect a server',
		prompt: `Prepare my server <ssh target> so my powder install can deploy to it (${doc('self-hosting', '#add-a-server')}).

- Check that it runs Linux and that I can log in as root: deploys run Docker, and the server check fixes nothing for another user.
- Check for Docker with the Compose plugin (2.24 or newer), git and flock (util-linux). Powder's "fix missing pieces" installs Docker when it is absent; git and flock I install with the distro's package manager, so tell me if they are missing.
- Append powder's public key to root's ~/.ssh/authorized_keys without removing existing keys. The key: <paste it from the add server form in the powder dashboard>.
- Report whether a reverse proxy (host nginx or a Traefik container) is running and on which ports, and compare it with ${doc('domains-and-proxy')}. Don't change it.
- Don't stop, remove or restart any running container, and don't change firewall rules.

Finish with what I enter in the add server form: a display name, the host or IP, the SSH user. Then I open the server, set its routing and base domain, and run "check server" and "fix missing pieces". After that I import the repo at /new and every push to its branch deploys.`,
	},
	{
		id: 'debug',
		title: 'Debug a failed deploy',
		prompt: `A powder deploy of this app failed. If the powder MCP server is connected (${doc('mcp')}), find the deploy with list_deploys and read it with get_deploy_log; otherwise use the log I pasted below. Powder runs these stages in order: preflight, build, test gate, swap gate, db migrate, release, swap-check, docker compose up, health check. They are described at ${doc('deploys')}.

- Find the last stage banner (like \`── preflight ──\`) and the first real error after it.
- If it failed at swap-check, the old container is still serving and the log includes the candidate's last 200 lines. Read those first.
- Explain the root cause in two sentences, then fix it in this repository.
- If the fix belongs on the server or in an env var, tell me exactly what to change instead of guessing.
- Don't add retries, sleeps or CI workflows to hide the failure.
- With MCP, after the fix is pushed, follow the new deploy with get_deploy_log until it succeeds or fails.

Deploy log (skip with MCP):
<paste the log from the deploy page>`,
	},
	{
		id: 'postgres',
		title: 'Add Postgres and env vars',
		prompt: `Wire this app to Postgres the way powder runs it (${doc('env-and-secrets')}).

- When I import the app at /new with "add a database" checked, powder runs Postgres 16 next to it and sets DATABASE_URL (host db, database app, user app). Read DATABASE_URL from the environment at runtime, with no hardcoded fallback in production.
- Run migrations with LABEL powder.release.cmd="<migrate command>" in the Dockerfile so they run once before the swap. Keep them backward compatible: a rollback restores the previous image but does not undo a migration.
- List every other env var the app reads: name, purpose, secret or not, needed at build time or not. I set them on the app's env page in the dashboard. NEXT_PUBLIC_* values must be Dockerfile build args.
- If the powder MCP server is connected (${doc('mcp')}), compare the list with list_env_keys and tell me which are missing. Set a non-secret one with set_env_var only after I confirm it; I enter secrets myself.
- Add a .env.example with the names and no real values.`,
	},
	{
		id: 'upgrade',
		title: 'Upgrade powder',
		prompt: `Upgrade my powder install on <ssh target> to the latest release, following ${doc('upgrading')}.

- Read CHANGELOG.md between my running version (the bottom of the sidebar, or version in \`curl -s http://127.0.0.1:3050/api/health\` on the server) and the new tag, and tell me about anything that needs a manual step before the upgrade.
- Take the pg_dump of powder's database that the page gives first: going back to an older release can need a restore.
- Wait until no deploy is running. Then in /opt/apps/powder/src on the server: \`git fetch --tags && git checkout <new tag> && sudo bin/install.sh\`. It keeps the env file, rebuilds and restarts powder and the worker, and the schema is applied on start.
- If it stops on a migration, show me the message. Don't skip it with --skip-migrations.
- When it is done, remind me to run "check server" on each server: it reports helpers that differ from the new release, and replaces one only when I tick it.`,
	},
]

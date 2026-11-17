// How to make powder and the worker re-read powder.env. A plain restart does
// not: the containers keep the env they were created with. Browser-safe, so
// the login page, /new, integrations and the setup checklist say the same.

export const RECREATE_COMMAND =
	'docker compose --env-file /opt/apps/powder.env up -d --force-recreate powder worker'

export const RECREATE_HINT = `in the powder source dir run: ${RECREATE_COMMAND} (or re-run bin/self-deploy.sh)`

/** The GitHub OAuth scopes powder asks for at sign-in: `repo` and `admin:repo_hook`
 *  to install deploy keys and webhooks, `read:user` and `user:email` for the account.
 *  README.md and the security model list the same scopes (a test checks it). */
export const GITHUB_OAUTH_SCOPES = ['repo', 'admin:repo_hook', 'read:user', 'user:email'] as const

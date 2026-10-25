# Contributing

Use Node 22.23.4 or newer and pnpm 10.30.3. Work from fetched origin/main in one
dedicated worktree and branch per change. Preserve unrelated work. Keep generic
provider mechanics here; inference and conversation execution belong to the
native engine, authority and lifecycle to Ez, domain policy to its owning app.

Run `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm release:check`,
`docker build --target runtime -t ez-twilio:check .` and `git diff --check`.
Authority, credential, state and uncertain-write changes need focused negative
tests. The Docker manager smoke is `EZ_CORE_SOURCE=/reviewed/ez-agents pnpm
smoke:manager`; it uses synthetic provider data and a disposable registry.

Commit, push and open a PR before installing the QA candidate. Verify the exact
reviewed source through the registered plugin CLI. Obtain one independent human
or agent review of the final head; passing CI alone is not review. Resolve material
findings, refresh affected evidence after changes, then complete the authorized
merge and remove the task worktree/branch. The owner request authorizes this normal
implementation/PR/merge loop; npm publication, tags and public release are separate.

An interrupted external write stays uncertain until reconciled. Never add a new
operation key, fallback provider or callback to make a failure appear successful.
Public instructions work without a maintainer's workspace. No customer records,
credentials, account exports, native transcripts or private QA belong in Git.

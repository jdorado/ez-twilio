# Releasing

Follow CONTRIBUTING.md in an isolated worktree and reviewed PR. Public source,
catalog registration and a publishing workflow do not establish a release.
`0.1.0-beta.1.rc.7` is an unpublished QA candidate. RC versions are never tagged
or published; the first intended public version is `0.1.0-beta.1`, subject to
fresh registry/tag readback. Never overwrite a published version.

## Prepare the exact package

1. Set matching package/manifest beta versions and update CHANGELOG.md. Keep
   state schema 1 unless a reviewed migration is supplied. Use a new RC after
   substantive QA fixes. Review Git history and the npm allowlist for private data.
2. Run frozen pnpm installation, `pnpm verify`, `pnpm release:check`,
   `git diff --check` and `pnpm audit --prod`. Review dependency licenses;
   never run an automatic audit fix. Refresh `docker/pnpm-lock.yaml` whenever
   the source lock changes. Node's bundled components retain upstream notices.
3. Build Docker `test` and `runtime` targets. Run `EZ_CORE_SOURCE=/absolute/reviewed-ez-agents
   pnpm smoke:manager` with the explicit reviewed core integration input. The
   disposable fixture proves managed installation, registered dispatch, exchange,
   repeated send keys, restart catch-up, retained receipts, backup and removal.
   It substitutes a synthetic provider and is not exact live-provider proof.
4. Run `npm pack --ignore-scripts --pack-destination /absolute/temporary-directory`.
   Inspect every packed path, record its SHA-256, and extract into a fresh
   directory. Copy `docker/pnpm-lock.yaml` to the extracted root, reinstall with
   frozen pnpm, repeat verification/CLI help and both Docker builds there.
5. For the first release or onboarding changes, install the exact candidate on
   a disposable clean host without sibling checkouts or personal profiles.
   Verify the actual bound executor, account/sender, first supported operation,
   restart and host boot. Use an authorized account and recipient for live sends;
   keep their receipts private. Synthetic tests and prior-RC live evidence alone
   do not satisfy this exact-artifact acceptance. State untested platforms.
6. Confirm public repository/package identities, publisher access, private
   vulnerability reporting, required CI and independent final-head review.
   Merge only after applicable checks and QA. Verify the merged source tree
   matches the tested tree and renew any evidence invalidated by changes.

## Publish under release authority

A request to release supplies authority for that release; do not ask again.
Implementation, installation or normalization alone does not authorize npm
publication, tags or a GitHub release. Report readiness if release was not requested.

The manual `.github/workflows/publish-beta.yml` is a generated caller of the
single immutable Ez shared publisher at core commit `84ec33f61c01bd349009a39cd4970345d13dd39f`
([catalog registration](https://github.com/jdorado/ez-agents/pull/313)).
Its `uses` and `publisher-sha` pins must
agree; required CI is the actual `verify` job from `.github/workflows/ci.yml`.
Regenerate from the pinned core checkout with:

```sh
node scripts/generate-publish-caller.mjs jdorado/ez-twilio \
  @jc_stack/ez-twilio 84ec33f61c01bd349009a39cd4970345d13dd39f '["verify"]'
```

Review the complete output before replacing the caller. The shared
[trusted-publishing guide](https://github.com/jdorado/ez-agents/blob/84ec33f61c01bd349009a39cd4970345d13dd39f/docs/trusted-publishing.md)
owns asset, receipt, OIDC and failure-reconciliation rules; do not copy its
implementation into this plugin or add npm tokens to Actions. Catalog registration
must be present at the pinned publisher commit. The caller is manual and inert
without an approved exact artifact and npm trust.

The npm package must exist before trust enrollment. For a real approved initial
beta, authenticate as the verified package owner and publish only the exact
tested tarball with public access on `latest`, using required 2FA. Never publish
a dummy version to test login. Then the account owner enrolls the exact caller
`jdorado/ez-twilio`, filename `publish-beta.yml`, with direct publication enabled.
This caller uses no environment. Read back npm trust rather than inferring it
from a merged workflow or local login.

For subsequent approved betas, wait for the exact current-main push CI, create
and verify `vVERSION` at that commit, and stage a draft GitHub prerelease with
the already tested bytes named `candidate.tgz` and a sanitized
`release-receipt.json`. Dispatch using its numeric release ID, version, source
SHA and artifact SHA-256. Do not rebuild on Actions or replace staged assets.

After either publication path, read back registry metadata, `latest`, downloaded
tarball SHA-256, GitHub prerelease/tag/source and release assets. Verify a clean
installation of that published version before calling release complete or
advertising an installable version. An uncertain publication requires registry
reconciliation before retry; never overwrite a version or silently repair tags.

## Compatibility and rollback

Schema 1 retains private credentials, messages, watch/cursor generations and
send-operation receipts in the managed volumes. This preparation changes no CLI
or data format. Back up before an upgrade; roll back compatible package code
without deleting provider state. Restoring an older journal requires the sending
barrier, replay/rebinding and post-snapshot reconciliation in README.md.
Uninstall preserves volumes; credential revocation is a separate account action.
The plugin does not supply end-to-end native core crash recovery.

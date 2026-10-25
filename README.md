# ez-twilio

Polling-only two-way Twilio SMS for Ez agents. One managed Docker container
captures incoming/outgoing messages and polls delivery status independently of
the agent worker. A private transactional journal holds messages, cursors,
watches and send receipts across process/container restarts. No webhooks or public
listener are required. The service never composes or automatically sends a reply.

Package: `@jc_stack/ez-twilio`. Source: [jdorado/ez-twilio](https://github.com/jdorado/ez-twilio).
This is an unpublished release candidate. Install reviewed source by its inspected
hash; do not assume an npm version or public release exists. Requires Node
22.23.4+ (including built-in SQLite) and an Ez manager supporting deployment v2.

## Install and configure

Use the owning agent's existing reviewed plugin registry:

```sh
ez plugins inspect twilio --source /reviewed/ez-twilio
ez plugins install twilio --source /reviewed/ez-twilio --revision sha256:INSPECTED_HASH
ez plugins start twilio
ez twilio init < /private/twilio-connection.json
ez twilio doctor
```

The private stdin JSON contains `accountSid`, `sender` (E.164), and either
`apiKeySid`/`apiKeySecret` or `authToken`. Prefer an API key with the required
message/number access. Optional: `messagingServiceSid`, `startAt` (UTC ISO capture
boundary, defaults to configuration time), `pollSeconds` (15–3600, default 60).
Capture includes the whole boundary second because provider timestamps lack milliseconds.
Credentials are never accepted as command flags or returned by diagnostics.
Reconfiguration may rotate credentials but cannot change account, sender or
capture boundary; a different identity requires a separate profile.

`doctor` performs an authenticated read and verifies that the intended sender
is SMS-capable and belongs to this account. This proves read access and binding,
not delivery or regulatory readiness. It does not change Twilio number routing.
Use an authorized test phone and a sender ready for the intended destination
before a live send.

## Messages and receipts

```sh
ez twilio sync --max-pages 20
ez twilio inbox --after 0 --limit 20
ez twilio acknowledge --consumer crm --cursor 42 --generation STORE_GENERATION
ez twilio send --to +15551234567 --text 'Authorized test' --key test:1 --preview
ez twilio send --to +15551234567 --text 'Authorized test' --key test:1
ez twilio operation --key test:1
ez twilio message get SM00000000000000000000000000000000
ez twilio status
```

Reads and writes print JSON. One send accepts 1–1600 characters. Reusing a key
with the identical payload reads its receipt; changing the payload is refused.
A timeout, process death or missing create response leaves the reserved operation
`uncertain` and is never automatically resubmitted. HTTP create requests have no
automatic retry. Polling can find similar messages but cannot prove which local
operation created one without its saved SID. Keep the key and reconcile; never
invent a replacement key to retry an uncertain effect. Acceptance and delivery
are distinct; SMS delivery is not a read receipt.

`inbox` is a replayable journal of message and status events in local sequence
order. A provider message is captured once by Account SID/Message SID; status
revisions are separate events. Commit domain records before acknowledging the
consumer cursor. Nonzero reads require `--generation STORE_GENERATION` from the
first page; stale generations and cursors beyond this store fail.
Acknowledging/releasing events does not delete the underlying correspondence.

The poller follows every provider page in both directions, persisting progress
with captured records. A bounded `sync` may report `complete:false`; background
capture continues that scan. Failed pages never mark coverage complete. Regular
scans overlap two days; daily full scans cover the configured activation boundary.
Startup resumes the uncompleted scan or catches up from durable coverage. Invalid
records/content conflicts are retained privately in quarantine and reported as
coverage gaps while healthy records and later pages continue to be captured.
MMS metadata is retained as unsupported; media processing is
not included. Status, lag, quarantine and uncertain-operation counts are visible
without returning credentials or message bodies.

## Native conversation integration

The protected socket `/plugins/twilio/service.sock` implements Ez's ordinary
`message-v1` source contract: `events-head`, `events`, `events-check`,
`events-release`, `task-watch`, `task-unwatch`, `task-send`. The private IPC volume
must be mounted and registered by the owning installation, using the standard Ez
source administration command. A plugin manifest or captured SMS is not a grant.
Account identity includes Account SID, our configured sender and store generation; a conversation
is the remote E.164 number under that binding. Exact-contact watches gate native
events and task sends. Unwatched correspondence is retained in the inbox but does
not wake the owner session. Task expiry/revocation, execution and context belong
to core; the plugin does not run an agent or import app logic.

For a domain app, consume the same journal and keep its matching, contact limits
and canonical timeline in the app. Do not give a restricted domain task a general
Twilio sender that bypasses those limits. A native task admission alone does not
prove its reply survived an Ez relay restart: verify the installed core's task
acknowledgment/recovery contract before claiming end-to-end conversation recovery.

## State, backup and removal

State lives in the managed `profile` volume at `/state/twilio`. The separate IPC
volume holds only the Unix socket. One service owns a profile using an OS-released
SQLite writer lock. Credentials use a mode-0600 file; message bodies and receipts
are private. Keep runtime state out of the agent's Markdown workspace.

`ez twilio backup` creates a consistent `backup.sqlite`; export it with
`ez plugins export twilio backup --output /private/backup.sqlite`. It contains SMS
content and receipts, not the separate credential file. Store both privately in
encrypted backups outside the host. Restore with the service stopped, preserve
the old state, replace `transport.sqlite` from the consistent snapshot, and remove
only that stopped database's old WAL/SHM files. Restart with the same connection.
The snapshot carries a recovery barrier: new sends are refused until catch-up and
owner reconciliation of post-snapshot sends. Only then use `recovery acknowledge
--reference OWNER_RECONCILIATION`; that command records the decision, it does not
prove provider correspondence or invent missing operation keys. Existing keys
still return their prior receipts. Do not resume old queued sends from an older
snapshot merely because their operation row is absent.
Snapshots rotate the store generation and remove consumer positions and watches.
Incremental consumers must explicitly replay from zero under the new generation;
native sources and grants must be rebound. Old cursor numbers and old grants
cannot silently resume against reused event sequence numbers.

`ez plugins stop twilio` stops capture; start catches up. `ez plugins uninstall
twilio` preserves volumes. Deleting the profile destroys credentials, cursors and
deduplication history; revoking Twilio credentials is a separate account action.
Provider retention, deletion and redaction bound REST recovery. No guarantee is
made for messages not received by Twilio or copies deleted everywhere.

## Development

`pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm release:check`.
For an extracted npm archive, first copy `docker/pnpm-lock.yaml` to
`pnpm-lock.yaml`; npm excludes root pnpm lockfiles from packages.
Run the Docker manager smoke with `EZ_CORE_SOURCE=/reviewed/ez-agents pnpm
smoke:manager`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

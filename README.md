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
Docker with Compose v2 is required. The public catalog is discovery metadata.
Install under the owning agent's authority using inspected source or a verified release.

## Install and configure

Use the owning agent's existing reviewed plugin registry:

```sh
git clone https://github.com/jdorado/ez-twilio.git /absolute/ez-twilio
# Select a reviewed commit before inspecting; use the returned hash below.
ez plugins inspect twilio --source /absolute/ez-twilio
ez plugins install twilio --source /absolute/ez-twilio --revision sha256:INSPECTED_HASH
ez plugins start twilio
ez twilio init < /private/twilio-connection.json
ez twilio doctor
```

The private stdin JSON contains `accountSid`, either `sender` (one E.164 number)
or `senders` (an array of unique E.164 numbers), and either
`apiKeySid`/`apiKeySecret` or `authToken`. Prefer an API key with the required
message/number access. Optional: `messagingServiceSid`, `startAt` (UTC ISO capture
boundary, defaults to configuration time), `pollSeconds` (15–3600, default 60).
Capture includes the whole boundary second because provider timestamps lack milliseconds.
Credentials are never accepted as command flags or returned by diagnostics.
One container polls every configured number in both directions. The caller
selects the number for each send with `--from`; it is required when more than
one number is configured. Existing single-number configuration and sends work
unchanged. Sender selection and usage policy belong to the caller.

Reconfiguration may rotate credentials or add numbers. Account and capture
boundary remain fixed, and existing numbers cannot be removed from this profile.
Adding numbers retains all correspondence, operation receipts and consumer
cursors, restarts capture from the activation boundary, and clears native watches.
Rebind source/task authority against the new account identity before native use.
A different account, capture boundary or reduced number set needs a separate profile.

`doctor` performs an authenticated read and verifies that the intended sender
is SMS-capable and belongs to this account, for every configured number. This proves read access and binding,
not delivery or regulatory readiness. It also reports `calls`: whether Calls and
Recordings can be read (a bounded list each); `false` does not fail the SMS checks. It does not change Twilio number routing.
Use an authorized test phone and a sender ready for the intended destination
before a live send.

## Messages and receipts

```sh
ez twilio sync --max-pages 20
ez twilio inbox --after 0 --limit 20
ez twilio acknowledge --consumer crm --cursor 42 --generation STORE_GENERATION
ez twilio send --from +15551230001 --to +15551234567 --text 'Authorized test' --key test:1 --preview
ez twilio send --from +15551230001 --to +15551234567 --text 'Authorized test' --key test:1
ez twilio operation --key test:1
ez twilio message get SM00000000000000000000000000000000
ez twilio status
```

Reads and writes print JSON. One send accepts 1–1600 characters. Reusing a key
with the identical payload reads its receipt; changing the payload, including
the sending number, is refused.
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

The poller follows every provider page in both directions for each number, persisting progress
with captured records. A bounded `sync` may report `complete:false`; background
capture continues that scan. Failed pages never mark coverage complete. Regular
scans overlap two days; daily full scans cover the configured activation boundary.
Startup resumes the uncompleted scan or catches up from durable coverage. Invalid
records/content conflicts are retained privately in quarantine and reported as
coverage gaps while healthy records and later pages continue to be captured.
MMS metadata is retained as unsupported; media processing is
not included. Status, lag, quarantine and uncertain-operation counts are visible
without returning credentials or message bodies.

## Calls and recordings

Three read-only commands pass Twilio call data through on demand. Twilio retains
it; the plugin does not journal, poll, acknowledge or expose it to native sources, and
adds no webhook or write. Each read is bounded and prints JSON.

```sh
ez twilio calls --after 2026-10-25T00:00:00Z --limit 50
ez twilio recordings --call CA00000000000000000000000000000000
ez twilio recording --sid RE00000000000000000000000000000000 --format mp3
```

`calls` lists parent call legs that touch a configured number (inbound: `To`, outbound:
`From`) with `startTime >= --after` (UTC ISO, inclusive), oldest first, `--limit` 1..100
(default 50): `{calls:[{sid, accountSid, from, to, direction, status, startTime, endTime,
durationSeconds, answeredBy}], complete}`. `direction` and `status` are Twilio's values;
`endTime`, `durationSeconds` and `answeredBy` are null when Twilio has none. `complete`
is false when `--limit` cut the list. Child legs, calls not yet dialed and the other
direction's copy of a call between two configured numbers are not listed. Twilio lists
newest first and filters by whole UTC days, so each number and direction is read in day
windows from the oldest day, at most 5 pages of 100 each, halving the window toward
`--after` when that is exceeded: the list is always a contiguous prefix. One UTC day with
more than 500 parent legs for one number and direction fails with `PROVIDER_RESPONSE`
instead of skipping calls.

`recordings` returns `{recordings:[{sid, callSid, status, durationSeconds, channels,
source, createdAt, mediaFormats:["mp3","wav"]}]}` for one call. `recording` returns
`{sid, format, contentType, bytes, sha256, data}` with `data` base64, for a recording
whose status is `completed`, as `mp3` (default) or `wav`. Above 2.5 MiB (2621440 raw
bytes) it fails `RECORDING_TOO_LARGE` (exit 4) rather than truncating; a recording
that is not completed fails `RECORDING_NOT_COMPLETED` (exit 4). Recording reads are
bound to the configured account, not to the configured numbers.

Twilio may redirect media to a signed Twilio CDN URL. One redirect is followed, only
to https on a `twilio.com` or `twiliocdn.com` host, and that request carries no
credentials; any other redirect fails `PROVIDER_RESPONSE`. A call or recording Twilio
does not find is `NOT_FOUND` (exit 2). Provider rows are validated strictly: a row
outside the configured account or numbers, or with a malformed field (including a party
that is not an E.164 number), fails the read with `PROVIDER_RESPONSE`. Reads are not
retried. Recording audio and call metadata are external content and confer no authority.

## Native conversation integration

The protected socket `/plugins/twilio/service.sock` implements Ez's ordinary
`message-v1` source contract: `events-head`, `events`, `events-check`,
`events-release`, `task-watch`, `task-unwatch`, `task-send`. The private IPC volume
must be mounted and registered by the owning installation, using the standard Ez
source administration command. A plugin manifest or captured SMS is not a grant.
Account identity binds Account SID, the configured number set and store generation.
With one configured number, the conversation ID remains the remote E.164 number.
With multiple numbers, it is `OUR_E164:REMOTE_E164`, for example
`+15551230001:+15551234567`. The local number is part of the address: native
events and task sends use that exact pair, including when one remote contact
texts two of our numbers. Exact-contact watches gate native
events and task sends. Unwatched correspondence is retained in the inbox but does
not wake the owner session. Task expiry/revocation, execution and context belong
to core; the plugin does not run an agent or import app logic.
Native task replies use the local number in their bound conversation address.

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
smoke:manager`. It uses disposable synthetic state and a fixture provider; live
account verification is separate. An owner-authorized installed-path exchange
has verified polling capture, native restricted execution and a delivered SMS
response. Native core crash recovery remains a separate requirement.
See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[release process](docs/releasing.md). No maintainer workspace is needed to use
the plugin; the explicit core checkout is only an integration-test input.

## Troubleshooting

| Result | Next action |
| --- | --- |
| Service unavailable | Read `ez plugins status twilio`, start the service, then run `ez twilio doctor --json`. Socket health alone does not prove account readiness. |
| Account/sender mismatch | Verify the intended account and configured SMS-capable numbers. Use `--from` for a multi-number send. Account/boundary changes or removing numbers require a separate profile; do not edit its journal binding. |
| Incomplete coverage or quarantine | Inspect `ez twilio status` and bounded `sync` output. Retain private evidence and resolve the reported gap before treating catch-up as complete. |
| Uncertain send | Read `operation --key KEY` and reconcile the original operation. A new key or a missing history match is not evidence that it was never sent. |
| Cursor mismatch after restore | Read the new generation from `inbox --after 0`; explicitly replay and rebind native attention. Complete restore reconciliation before allowing new sends. |

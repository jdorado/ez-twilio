# Changelog

## 0.1.0-beta.1.rc.12 — unpublished candidate

The `calls` read says why Twilio failed a call: `errorCode`, the code of the call's first error
notification (for example 13224, not a valid phone number, or 32009, the carrier refused the call),
read only for a call whose status is `failed` and null otherwise or when Twilio logged none. A
consumer can then tell a dead or refusing number from a fault on its own side. Nothing else changes.

## 0.1.0-beta.1.rc.11 — unpublished candidate

`ring`: a missed call. One Calls create request from a configured number with a ring timeout and an
inline `<Hangup/>`, so Twilio itself stops ringing after `--seconds` (5 to 60, default 10) and
nobody who picks up is connected to anything: no audio, no webhook, no second request to cancel. It
has the send contract: a durable operation under `--key`, reserved before the one provider request,
the same key and payload read back the kept call, a lost response stays `uncertain` and is never
submitted again, a definitive refusal is `rejected`. Polling reads the call back by its SID until
Twilio reports it finished: `settled` for `no-answer`, `busy` and `completed`, `failed` for `failed` and
`canceled` (a call that never rang), with `providerStatus` and `durationSeconds` on the operation. The `calls` read names the operation key of a call this plugin placed (`operation`,
null for any other call), so a consumer tells a ring from a conversation. `doctor` also reports
`voice`: whether every configured number can place one. Nothing else changes: the journal, the
native source protocol and state schema 1.

## 0.1.0-beta.1.rc.10 — unpublished candidate

A text from a short code or an alphanumeric sender is captured instead of quarantined. It
was rejected as "not E.164", and because a quarantined record keeps a scan from completing,
polling coverage stopped advancing on the first such text and never recovered on its own.
Our own number stays strictly E.164; only the other party may be a short code (3 to 8
digits) or an alphanumeric sender (up to 11 characters with at least one letter, so
`1Password` counts). Replying to one is still refused. A quarantined record that later
captures is removed from quarantine, so the count falls and the next scan completes
(an already-quarantined short-code text clears the next time a scan reads that message,
normally the first scan after the upgrade). A content conflict is never cleared this way:
its evidence stays until it is reconciled.
Nothing else changes: the journal, the native source protocol and state schema 1.

## 0.1.0-beta.1.rc.9 — unpublished candidate

Read-only `calls`, `recordings` and `recording` commands: bounded Twilio pass-through
reads of the configured numbers' parent call legs, a call's recordings and one
completed recording's media (base64, hard 2.5 MiB limit, `RECORDING_TOO_LARGE`).
They are not journaled and add no webhook, write, credential or state change. Call
lists are read oldest day first so a page bound never skips calls. Recording media may
follow one redirect, only to https on a Twilio host and without credentials.
`doctor` also reports `calls`, whether Calls and Recordings can be read. SMS capture,
the journal, the native source protocol and state schema 1 are unchanged.

## 0.1.0-beta.1.rc.8 — unpublished candidate

Multiple configured numbers in one account/container, caller-selected `send
--from`, and durable polling progress across every number in both directions.
Native conversation addresses include our number when several are configured,
keeping the same remote contact's line-specific watches and replies separate.
Existing single-number configuration and operation receipts remain compatible.
Numbers can be added without losing the journal; capture restarts from activation
and native attention must be rebound. No rotation, daily-cap or selection policy
is implemented in the plugin. Multi-number configuration requires this version
or newer; older RCs cannot load it. SQL state schema remains 1.

## 0.1.0-beta.1.rc.7 — unpublished candidate

Standard public contribution and release instructions, PR template, pinned shared
beta publishing caller, explicit catalog registration with release pending, and
packed release documentation. Docker CI now runs the existing offline tests in
the supported Node image. Provider behavior, CLI and state schema are unchanged.
An installed live SMS/native-task exchange passed on the preceding RC; this does
not establish core crash recovery or a published package.

## 0.1.0-beta.1.rc.6 — unpublished candidate

Polling-only incoming/outgoing SMS capture, persisted pagination, local event
cursors, replay protection, reserved send keys, delivery-status readback, private
credentials, managed container, exact-contact source protocol and consistent
backups with a restore sending barrier. Live conversation acceptance remains
separate from synthetic tests and account readback.

Review corrections: quarantined records do not starve valid capture, restores
rotate cursor/source identity and remove old watches, and status checks rotate
fairly even when a read fails. Nonzero inbox cursors require their store generation.
The candidate archive includes its frozen pnpm lockfile under `docker/`, matching
the Ez artifact pattern because npm excludes root pnpm lockfiles.
Capture includes the full activation second to respect Twilio timestamp precision.
To/From listings distinguish inbound messages from another owned number's outbound copy.

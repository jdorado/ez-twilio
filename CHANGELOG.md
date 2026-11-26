# Changelog

## 0.1.0-beta.1.rc.19 — unpublished candidate

A client that gives up while a recording is being sent no longer leaves the spool file or its open handle behind, and a
disk error while the media is spooling fails that call instead of the service.

## 0.1.0-beta.1.rc.18 — unpublished candidate

`recording` no longer holds the audio in memory. The service held the file, its base64 and the JSON reply at once,
about five times the audio, so a 45-minute two-channel call (about 21 MB) was OOM-killed in the 128 MiB container on
every attempt, restarting the service each time, and its recording was never kept; rc.17 had raised the size bound to
64 MiB without the memory to carry it. The audio is now written to a file under the profile as it downloads (size and
digest computed on the way), then sent as base64 in pieces, and the file is removed; the service clears leftovers
when it starts. The reply is the same JSON. The download has 25 s (was 12 s for any request) to finish inside the 30 s
a client waits. A deployment change (a larger memory limit) would need a reviewed updater migration, so none is made.

## 0.1.0-beta.1.rc.17 — unpublished candidate

`recording` returns media up to 64 MiB (was 2.5 MiB), and the client accepts a reply up to 96 MiB (was 4 MiB) to
carry it as base64. Twilio's two-channel mp3 runs about 8 KB a second, so the old bound failed every call over about
five minutes with `RECORDING_TOO_LARGE`: a real 21-minute owner conversation (10 MB) lost its audio. 64 MiB holds a
two-hour call.

## 0.1.0-beta.1.rc.16 — unpublished candidate

The text poller asks Twilio for a window of days with the date filters Twilio applies. It sent `DateSent>=`
and `DateSent<=`, a spelling Twilio ignores without an error, so every poll listed every message the line
had ever sent or received and the cost of a poll grew with its history. The filters are now `DateSent>`
(from the start of the first day) and `DateSent<` (before the day after the last one). Read back on a live
account, `DateSent<` excludes the day it names, like `StartTime<` of the calls read, whatever the Messages
page says, so the upper bound is the day after the last day. A poll after a complete scan now reads the days
since its checkpoint (from the start of the day two days back, today included); the daily full scan still reads
from activation, so a later status change of an older message that this plugin did not send is picked up by it.
The plugin's own sends that are not yet settled are read back by SID after each poll's scan, up to 20. A date
filter matches on the send time: a message with none yet (queued or scheduled) is listed once Twilio gives it
one; whether a message that never gets one (failed before it left Twilio) is listed was not observed. Every
message read back on the live account for this change had a send time, and the lists of a split day summed
exactly to the whole list.
The test simulator honours only the suffix spelling, so a filter Twilio would ignore can no longer pass.

## 0.1.0-beta.1.rc.15 — unpublished candidate

The `calls` read asks Twilio for a day with the date filters Twilio applies. It sent `StartTime>=` and
`StartTime<=`, a spelling Twilio ignores without an error, so a read of one day returned every call the
line had ever made. A line whose all-time count passed the page bound (500 calls in one direction) then
failed every read with "One UTC day holds more calls than a read can bound", and a consumer reading by
cursor never got past it. The filters are now `StartTime>` (from the start of the first day) and
`StartTime<` (before the day after the last one), the operator being a suffix of the name as Twilio
documents it, so a day's bound is a day's calls. The test simulator honours only that spelling, so a
filter Twilio would ignore can no longer pass. The text poller's `DateSent>=` / `DateSent<=` is
unchanged here.

## 0.1.0-beta.1.rc.14 — unpublished candidate

A read keeps its HTTP status when Twilio or a gateway in front of it answers without JSON (a 502 page,
an empty 503, a 429 page): it is `PROVIDER_HTTP` or `PROVIDER_AUTH` with `httpStatus`, no longer
`PROVIDER_RESPONSE`, so a consumer tells a passing fault from a refusal. Without it the `errorCode`
lookup of rc.13 took a gateway fault for a refusal and left the code null for good. A write is
unchanged: a non-JSON answer to a create stays `PROVIDER_RESPONSE` and its operation `uncertain`.

## 0.1.0-beta.1.rc.13 — unpublished candidate

Two ways one odd Twilio value could still stop a `calls` read, and with it every later call for a
consumer reading by cursor, are closed (review of rc.12). The other party is never rejected: it is
returned as Twilio reports it, printable ASCII cut to 64 characters (`?` for any other character,
`unknown` when absent). A `errorCode` lookup that Twilio refuses for good (a key without Notifications
access, the resource removed or changed) leaves `errorCode` null instead of failing the read; a
transient failure of it (timeout, 5xx, 408, 429) still fails the read, which a consumer retries.
`errorCode` is the code of the first error-level notification, else of the first notification.

## 0.1.0-beta.1.rc.12 — unpublished candidate

The `calls` read says why Twilio failed a call: `errorCode`, the code of the call's first error
notification (for example 13224, not a valid phone number, or 32009, the carrier refused the call),
read only for a call whose status is `failed` and null otherwise or when Twilio logged none. A
consumer can then tell a dead or refusing number from a fault on its own side.

The `calls` read no longer fails when a call's other party is not an E.164 number. An inbound call
with a withheld caller ID (`from` is `anonymous`, `restricted` or `+464`) made the whole read fail
with `PROVIDER_RESPONSE`, so a consumer reading from a cursor stopped at that call and could not read
any later one. The other party is now returned as Twilio reports it (at most 64 characters of
letters, digits and `_.:@+-`); only our own number must be E.164, as for a text from a short code.

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

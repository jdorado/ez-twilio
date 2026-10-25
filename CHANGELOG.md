# Changelog

## 0.1.0-beta.1.rc.5 — unpublished candidate

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

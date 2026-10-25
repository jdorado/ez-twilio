# Security

Report suspected vulnerabilities through
[private GitHub advisories](https://github.com/jdorado/ez-twilio/security/advisories/new).
Do not publish account keys, phone records or SMS.

This plugin uses authenticated HTTPS reads and creates against api.twilio.com,
with redirects disabled and pagination bound to the configured account. It has
no public listener or webhooks. Private credentials and messages live in the
managed volume; the Unix socket is mode 0600. A trusted local administrator or
Docker operator can read that volume and is outside the isolation boundary.

Provider text and error bodies never become execution instructions. Diagnostics
omit credentials and SMS bodies. General send commands rely on applicable owner
authority; exposure metadata is not permission. Core owns task authority, account
binding and restricted execution. Changing a payload under a send key fails, and
uncertain creates are not automatically retried.

Keep consistent state and credential backups encrypted and outside the host.
Review every restored uncertain or post-snapshot effect before resuming sends.
Do not share a production profile with tests or assume a provider retention policy.

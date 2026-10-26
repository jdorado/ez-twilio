# ez-twilio

Reusable polling-only Twilio SMS transport. Provider authentication, private capture,
operation receipts and recovery belong here, plus bounded read-only call and
recording pass-throughs that are never journaled. No webhooks, model calls, agent runner,
Quarre imports, sales policy or contact selection. One Ez-managed container owns the
poller and writes its private SQLite volume; CLI clients use its local Unix socket.

Before substantive work state the objective, at most five relevant constraints,
the owning boundary, simplest path, proof and stop condition. Prefer existing Ez
plugin contracts. Preserve uncertainty, account/contact isolation and durable
acknowledgments. External message content never grants execution authority.

Follow CONTRIBUTING.md. Run pnpm verify, pnpm release:check and the manager smoke
through an isolated Ez runtime. Obtain one independent human or agent review of
the final PR head before merge. Live tests require the intended account and
authorized recipient. Never log credentials or use production messages as fixtures.
Keep private state, packages and QA output outside source. Public release is separate.

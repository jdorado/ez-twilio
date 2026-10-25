import {DatabaseSync, backup} from 'node:sqlite';
import {mkdirSync, chmodSync, existsSync, lstatSync} from 'node:fs';
import {open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fail} from './errors.mjs';
import {senders} from './validation.mjs';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => value === undefined ? null : JSON.stringify(value);
const read = row => row ? JSON.parse(row.value) : null;

export class Store {
  constructor(directory) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    if (lstatSync(directory).isSymbolicLink()) throw fail('INVALID_STATE', 'State directory cannot be a symlink');
    this.directory = directory;
    this.file = join(directory, 'transport.sqlite');
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw fail('INVALID_STATE', 'State database cannot be a symlink');
    this.db = new DatabaseSync(this.file, {timeout: 1000});
    chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, value TEXT NOT NULL, immutable_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES message(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation (key TEXT PRIMARY KEY, value TEXT NOT NULL, digest TEXT NOT NULL, provider_sid TEXT, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operation_sid ON operation(provider_sid);
      CREATE TABLE IF NOT EXISTS watch (conversation TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumer (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quarantine (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('CORRUPT_STATE', 'Database integrity check failed');
    if (!this.meta('generation')) this.setMeta('generation', randomUUID());
    if (!this.meta('schema')) this.setMeta('schema', 1);
    if (this.meta('schema') !== 1) throw fail('CORRUPT_STATE', 'Unsupported state schema');
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(name) { return read(this.db.prepare('SELECT value FROM meta WHERE key=?').get(name)); }
  setMeta(name, value) { this.db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, json(value)); }
  binding(connection, commit = true) {
    const numbers = senders(connection);
    const identity = {accountSid: connection.accountSid, ...(numbers.length === 1 ? {sender: numbers[0]} : {senders: numbers}), startAt: connection.startAt};
    const old = this.meta('binding');
    if (old && (old.accountSid !== identity.accountSid || old.startAt !== identity.startAt || senders(old).some(number => !numbers.includes(number))))
      throw fail('ACCOUNT_MISMATCH', 'Use a separate plugin profile for a different account, removed sender or capture boundary', 3);
    if (!commit) return;
    this.transaction(() => {
      if (old && hash(old) !== hash(identity)) {
        // Added numbers need complete capture from activation and fresh native grants.
        // Retain all correspondence, send receipts and consumer positions.
        this.setMeta('scan', null); this.setMeta('coverage', null);
        this.db.exec('DELETE FROM watch');
      }
      this.setMeta('binding', identity);
    });
  }
  getMessage(id) { return read(this.db.prepare('SELECT value FROM message WHERE id=?').get(id)); }
  capture(row) {
    const observedAt = row.capturedAt;
    const immutable = hash([row.accountSid, row.id, row.from, row.to, row.direction, row.body, row.mediaCount, row.createdAt]);
    const old = this.db.prepare('SELECT * FROM message WHERE id=?').get(row.id);
    if (old && old.immutable_hash !== immutable) throw fail('CONTENT_CONFLICT', 'Known Message SID changed immutable content; capture remains incomplete', 4);
    if (!old) {
      this.db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(row.id, json(row), immutable);
      this.db.prepare('INSERT INTO event(id, kind, message_id, value) VALUES (?, ?, ?, ?)').run(`${row.id}_message`, 'message', row.id, json(row));
    } else {
      const prior = JSON.parse(old.value);
      if (Date.parse(row.updatedAt) >= Date.parse(prior.updatedAt)) {
        row = {...row, capturedAt: prior.capturedAt};
        this.db.prepare('UPDATE message SET value=? WHERE id=?').run(json(row), row.id);
      } else row = prior;
    }
    const revision = `${row.id}_${hash([row.status, row.errorCode, row.updatedAt]).slice(0,32)}`;
    this.db.prepare('INSERT OR IGNORE INTO event(id, kind, message_id, value) VALUES (?, ?, ?, ?)').run(revision, 'status', row.id, json(row));
    // A SID is conclusive only when the operation already recorded it.
    for (const operation of this.db.prepare('SELECT value FROM operation WHERE provider_sid=?').all(row.id).map(read)) this.saveOperation({...operation,
      state: ['delivered', 'failed', 'undelivered', 'sent'].includes(row.status) ? row.status : 'accepted',
      providerStatus: row.status, errorCode: row.errorCode, updatedAt: observedAt, lastStatusCheckAt: observedAt});
    return !old;
  }
  quarantine(input, code) {
    this.db.prepare('INSERT OR IGNORE INTO quarantine VALUES (?, ?)').run(hash(input), json({code, capturedAt: new Date().toISOString(), raw: input}));
  }
  page(rows, scan) {
    return this.transaction(() => {
      let captured = 0;
      for (const row of rows) captured += Number(this.capture(row));
      this.setMeta('scan', scan);
      return captured;
    });
  }
  head() { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM event').get().seq); }
  inbox(after = 0, limit = 20, generation) {
    if ((after > 0 || generation !== undefined) && generation !== this.meta('generation')) throw fail('CURSOR_MISMATCH', 'Supply this store generation with a nonzero cursor; replay explicitly after restoration');
    if (after > this.head()) throw fail('CURSOR_AHEAD', 'Cursor is beyond this store; reconcile restoration before consuming');
    const rows = this.db.prepare('SELECT seq,id,kind,value FROM event WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    return {generation: this.meta('generation'), events: rows.map(row => ({seq: Number(row.seq), id: row.id, kind: row.kind, message: JSON.parse(row.value)})),
      nextCursor: rows.length ? Number(rows.at(-1).seq) : after, head: this.head()};
  }
  acknowledge(id, cursor, generation) {
    if (generation !== this.meta('generation') || cursor > this.head()) throw fail('CURSOR_MISMATCH', 'Acknowledgment does not belong to this store');
    const old = this.db.prepare('SELECT cursor FROM consumer WHERE id=?').get(id);
    if (old && cursor < old.cursor) throw fail('CURSOR_MISMATCH', 'Acknowledgment cannot move backward');
    this.db.prepare('INSERT INTO consumer VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor').run(id,cursor,generation);
    return {consumer: id, cursor, generation};
  }
  operation(key) { return read(this.db.prepare('SELECT value FROM operation WHERE key=?').get(key)); }
  operations() { return this.db.prepare('SELECT value FROM operation').all().map(read); }
  unsettled(limit = 20) { return this.db.prepare("SELECT value FROM operation WHERE provider_sid IS NOT NULL AND state NOT IN ('delivered','failed','undelivered','rejected') ORDER BY coalesce(json_extract(value,'$.lastStatusCheckAt'),json_extract(value,'$.updatedAt')),key LIMIT ?").all(limit).map(read); }
  reserve(payload, now) {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operation WHERE key=?').get(payload.key);
      const digest = hash(payload);
      if (old) {
        if (old.digest !== digest) throw fail('KEY_CONFLICT', 'Operation key is already bound to a different payload', 4);
        return {existing: true, operation: JSON.parse(old.value)};
      }
      if (this.meta('recovery')) throw fail('RESTORE_REVIEW', 'Restored transport state requires reconciliation before sending', 4);
      const operation = {...payload, state: 'uncertain', providerMessageId: null, createdAt: now, updatedAt: now};
      this.db.prepare('INSERT INTO operation VALUES (?,?,?,?,?)').run(payload.key, json(operation), digest, null, operation.state);
      return {existing: false, operation};
    });
  }
  saveOperation(operation) { this.db.prepare('UPDATE operation SET value=?,provider_sid=?,state=? WHERE key=?').run(json(operation), operation.providerMessageId, operation.state, operation.key); }
  watches() { return this.db.prepare('SELECT conversation,value FROM watch').all().map(row => ({conversation: row.conversation, ...JSON.parse(row.value)})); }
  watch(conversation, expiresAt, now) {
    const old = read(this.db.prepare('SELECT value FROM watch WHERE conversation=?').get(conversation));
    if (!old || old.expiresAt <= now) this.db.prepare('INSERT OR REPLACE INTO watch VALUES (?,?)').run(conversation, json({floor: this.head(), since: now, expiresAt}));
    else this.db.prepare('UPDATE watch SET value=? WHERE conversation=?').run(json({...old, expiresAt}),conversation);
    return {watching: conversation, expiresAt};
  }
  unwatch(conversation) { this.db.prepare('DELETE FROM watch WHERE conversation=?').run(conversation); return {watching: false}; }
  release(ids) {
    for (const id of ids) this.setMeta(`released:${id}`, true);
    return {released: true};
  }
  status() {
    const states = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM operation GROUP BY state').all().map(row => [row.state,Number(row.n)]));
    return {head: this.head(), generation: this.meta('generation'), binding: this.meta('binding'), coverage: this.meta('coverage'),
      scanPending: Boolean(this.meta('scan')), lastPoll: this.meta('lastPoll'), recovery: this.meta('recovery'),
      messages: Number(this.db.prepare('SELECT count(*) AS n FROM message').get().n),
      quarantined: Number(this.db.prepare('SELECT count(*) AS n FROM quarantine').get().n), operations: states};
  }
  async backup() {
    const since = new Date().toISOString(), temporary = join(this.directory, 'backup.sqlite.tmp'), target = join(this.directory, 'backup.sqlite');
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await backup(this.db, temporary);
    chmodSync(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary);
    try {
      snapshot.exec('BEGIN IMMEDIATE');
      snapshot.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('recovery', json({since, reason: 'restored_snapshot'}));
      snapshot.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('generation', json(randomUUID()));
      snapshot.exec('DELETE FROM watch; DELETE FROM consumer; COMMIT');
    }
    finally { snapshot.close(); }
    const fd = await open(temporary, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, target);
    const parent = await open(this.directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    return {backup: 'backup.sqlite', recoveryRequiredOnRestore: true, since};
  }
}

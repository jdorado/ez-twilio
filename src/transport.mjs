import {Provider, message} from './provider.mjs';
import {fail, publicError} from './errors.mjs';
import {integer, key, phone, sendInput} from './validation.mjs';

const DAY = 86400000;
export class Transport {
  constructor(store, connection, options = {}) {
    this.store = store;
    this.connection = connection;
    this.now = options.now ?? Date.now;
    this.provider = options.provider ?? new Provider(connection);
    this.pendingSync = null;
  }
  async sync(maxPages = 20) {
    integer(maxPages, 1, 200, 'page bound');
    if (this.pendingSync) return this.pendingSync;
    this.pendingSync = this.scan(maxPages).finally(() => { this.pendingSync = null; });
    return this.pendingSync;
  }
  async scan(maxPages) {
    // Twilio timestamps have second precision. Retain the whole boundary second
    // so an SMS arriving just after init is not excluded by local milliseconds.
    const now = this.now(), activation = Math.floor(Date.parse(this.connection.startAt) / 1000) * 1000;
    let scan = this.store.meta('scan');
    if (!scan) {
      const coverage = this.store.meta('coverage');
      const full = !coverage?.fullAt || now - Date.parse(coverage.fullAt) >= DAY;
      const since = full ? activation : Math.max(activation, Date.parse(coverage.completedThrough) - 2 * DAY);
      scan = {since, until: now, full, direction: 'inbound', path: this.provider.listPath('inbound', date(since), date(now)), pages: 0, gaps: 0};
    }
    let inspected = 0, captured = 0, pages = 0;
    try {
      let gaps = scan.gaps ?? 0;
      while (scan && pages < maxPages) {
        const page = await this.provider.page(scan.path);
        const rows = [];
        for (const raw of page.messages) {
          try {
            // Date filters are day-granular. Old/redacted records outside this
            // installation's activation boundary are not a historical import.
            const sourceTime = Date.parse(raw?.date_created);
            if (Number.isFinite(sourceTime) && (sourceTime < activation || sourceTime > scan.until)) continue;
            // To/From filters do not filter direction: another number in this
            // account may send to ours. Its outbound copy is not our inbound SMS.
            if (raw?.account_sid === this.connection.accountSid &&
                (scan.direction === 'inbound' && ['outbound-api','outbound-call','outbound-reply'].includes(raw.direction) ||
                 scan.direction === 'outbound' && raw.direction === 'inbound')) continue;
            const row = message(raw, this.connection, this.now());
            if ((row.direction === 'inbound') !== (scan.direction === 'inbound')) throw fail('PROVIDER_RESPONSE', 'Message page direction mismatch');
            if (Date.parse(row.createdAt) >= activation && Date.parse(row.createdAt) <= scan.until) rows.push({row, raw});
          } catch (error) { this.store.quarantine(raw, publicError(error).code); gaps++; }
        }
        inspected += page.messages.length;
        if (page.next === scan.path) throw fail('PROVIDER_RESPONSE', 'Provider pagination did not advance');
        const next = page.next ? {...scan, path: page.next, pages: scan.pages + 1}
          : scan.direction === 'inbound' ? {...scan, direction: 'outbound', path: this.provider.listPath('outbound', date(scan.since), date(scan.until)), pages: scan.pages + 1} : null;
        captured += this.store.transaction(() => {
            let count = 0;
            for (const {row,raw} of rows) {
              try { count += Number(this.store.capture(row)); }
              catch (error) {
                if (error.code !== 'CONTENT_CONFLICT') throw error;
                this.store.quarantine(raw,error.code); gaps++;
              }
            }
            if (next) next.gaps = gaps;
            this.store.setMeta('scan', next);
            if (!next) {
              const prior = this.store.meta('coverage');
              this.store.setMeta('coverage', {completedThrough: gaps ? prior?.completedThrough ?? this.connection.startAt : new Date(scan.until).toISOString(),
                scannedThrough: new Date(scan.until).toISOString(), gaps,
                fullAt: scan.full && !gaps ? new Date(scan.until).toISOString() : prior?.fullAt ?? null});
            }
            return count;
        });
        scan = next;
        pages++;
      }
      // Known outbound SIDs can change long after they leave the capture window.
      // A failed status read must not prevent capture of new incoming messages.
      const statusErrors = [];
      for (const operation of this.store.unsettled()) {
        try { await this.refresh(operation.providerMessageId); }
        catch (error) {
          this.store.saveOperation({...operation,lastStatusCheckAt:new Date(this.now()).toISOString()});
          statusErrors.push({key: operation.key, code: publicError(error).code});
        }
      }
      const result = {at: new Date(this.now()).toISOString(), scanComplete: !scan, complete: !scan && !gaps, gaps, inspected, captured, pages, statusErrors};
      this.store.setMeta('lastPoll', {...result, error: null});
      return result;
    } catch (error) {
      this.store.setMeta('lastPoll', {at: new Date(this.now()).toISOString(), complete: false, error: publicError(error).code});
      throw error;
    }
  }
  async refresh(id) {
    const row = message(await this.provider.get(id), this.connection, this.now());
    if (row.id !== id) throw fail('PROVIDER_RESPONSE', 'Message readback returned another SID');
    this.store.transaction(() => this.store.capture(row));
    return row;
  }
  async send(args) {
    const payload = sendInput(args, this.connection);
    if (args.preview === true) return {preview: true, payload};
    const reservation = this.store.reserve(payload, new Date(this.now()).toISOString());
    if (reservation.existing) return reservation.operation;
    let operation = reservation.operation;
    try {
      const response = await this.provider.create(payload);
      // Persist any returned SID before interpreting optional provider fields.
      if (typeof response?.sid !== 'string' || !/^(?:SM|MM)[a-fA-F0-9]{32}$/.test(response.sid) || response.account_sid !== payload.accountSid)
        throw fail('PROVIDER_RESPONSE', 'Provider did not return a bound Message SID', 5);
      operation = {...operation, state: 'accepted', providerMessageId: response.sid, providerStatus: typeof response.status === 'string' ? response.status : null,
        updatedAt: new Date(this.now()).toISOString()};
      this.store.saveOperation(operation);
      return operation;
    } catch (error) {
      const details = publicError(error);
      operation = {...operation, state: details.definitive === true ? 'rejected' : 'uncertain',
        error: {code: details.code, ...(details.httpStatus ? {httpStatus: details.httpStatus} : {}), ...(details.providerCode ? {providerCode: details.providerCode} : {})},
        updatedAt: new Date(this.now()).toISOString()};
      this.store.saveOperation(operation);
      return operation;
    }
  }
  accountId() { return `${this.connection.accountSid}:${this.connection.sender}:${this.store.meta('generation')}`; }
  checkAccount(args) {
    if (args.accountId !== this.accountId()) throw fail('ACCOUNT_MISMATCH', 'Task is bound to another account or sender', 3);
  }
  watch(args) {
    this.checkAccount(args);
    const conversation = phone(args.conversationId), now = this.now();
    if (!Number.isFinite(args.expiresAt) || args.expiresAt <= now || args.expiresAt > now + 72 * 3600000 && args.expiresAt !== 8640000000000000) throw fail('INVALID_INPUT', 'Invalid task watch expiry');
    return this.store.watch(conversation, args.expiresAt, now);
  }
  eligible(event) {
    if (event.kind !== 'message' || event.message.direction !== 'inbound' || this.store.meta(`released:${event.id}`)) return false;
    const watch = this.store.watches().find(row => row.conversation === event.message.from);
    return watch && watch.expiresAt > this.now() && event.seq > watch.floor && Date.parse(event.message.createdAt) >= watch.since - 1000;
  }
  sourceEvent(event) {
    const row = event.message;
    const text = [...row.body].slice(0,1600).join('');
    return {id: event.id, conversationId: row.from, receivedAt: Date.parse(row.capturedAt),
      text: JSON.stringify({messageId: row.id, from: row.from, to: row.to, text,
        ...(text !== row.body ? {truncated: true} : {}), unsupported: row.unsupported, mediaCount: row.mediaCount})};
  }
  events(after) {
    integer(after, 0, Number.MAX_SAFE_INTEGER, 'event cursor');
    if (this.store.meta('recovery')) throw fail('RESTORE_REVIEW','Reconcile restoration and rebind source authority before consuming native events',4);
    const page = this.store.inbox(after, 100, this.store.meta('generation')), events = [];
    let cursor = after;
    for (const event of page.events) {
      cursor = event.seq;
      if (this.eligible(event)) events.push(this.sourceEvent(event));
      if (events.length === 10) break;
    }
    return {cursor, events};
  }
  check(ids) {
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !/^(?:SM|MM)[a-fA-F0-9]{32}_message$/.test(id))) throw fail('INVALID_INPUT', 'Supply up to 10 incoming event IDs');
    const events = [];
    for (const id of ids) {
      const row = this.store.db.prepare('SELECT seq,id,kind,value FROM event WHERE id=?').get(id);
      if (!row) continue;
      const event = {seq: Number(row.seq), id, kind: row.kind, message: JSON.parse(row.value)};
      if (this.eligible(event)) events.push(this.sourceEvent(event));
    }
    return {events};
  }
  async taskSend(args) {
    this.checkAccount(args);
    const to = phone(args.conversationId);
    const watch = this.store.watches().find(row => row.conversation === to && row.expiresAt > this.now());
    if (!watch) throw fail('TASK_EXPIRED', 'Task attention is absent or expired', 3);
    const operation = await this.send({to, text: args.text, key: key(args.key)});
    return {accountId: this.accountId(), conversationId: to, key: operation.key,
      state: ['accepted','sent','delivered'].includes(operation.state) ? 'accepted' : 'uncertain', receiptId: operation.providerMessageId};
  }
}
const date = millis => new Date(millis).toISOString().slice(0,10);

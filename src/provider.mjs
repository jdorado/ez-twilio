import {fail} from './errors.mjs';
import {phone, sid, sender, senders} from './validation.mjs';

const ORIGIN = 'https://api.twilio.com';
export class Provider {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.fetch = options.fetch ?? fetch;
    this.timeout = options.timeout ?? 12000;
    this.root = `/2010-04-01/Accounts/${connection.accountSid}`;
  }
  async request(path, form) {
    // Pagination is untrusted provider input. Credentials never follow a redirect,
    // another origin, another account, or a non-message resource.
    if (typeof path !== 'string' || !path.startsWith(`${this.root}/`)) throw fail('PROVIDER_RESPONSE', 'Invalid provider resource');
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !url.pathname.startsWith(`${this.root}/`)) throw fail('PROVIDER_RESPONSE', 'Invalid provider resource');
    const {apiKeySid, apiKeySecret, accountSid, authToken} = this.connection;
    let response;
    try {
      response = await this.fetch(url.href, {method: form ? 'POST' : 'GET', redirect: 'error',
        headers: {Authorization: `Basic ${Buffer.from(`${apiKeySid ?? accountSid}:${apiKeySecret ?? authToken}`).toString('base64')}`,
          ...(form ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
        ...(form ? {body: new URLSearchParams(form).toString()} : {}), signal: AbortSignal.timeout(this.timeout)});
      const raw = await boundedBody(response);
      let value;
      try { value = JSON.parse(raw); } catch { throw fail('PROVIDER_RESPONSE', 'Provider returned invalid JSON'); }
      if (!response.ok) {
        const definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
        throw fail(response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_HTTP',
          `Twilio returned HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 3 : 2,
          {httpStatus: response.status, definitive, ...(Number.isSafeInteger(value?.code) ? {providerCode: value.code} : {})});
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('PROVIDER_RESPONSE', 'Invalid provider response');
      return value;
    } catch (error) {
      if (error?.exitCode) throw error;
      throw fail('PROVIDER_UNAVAILABLE', 'Twilio request interrupted; read back the existing operation before retrying a send', 5);
    }
  }
  listPath(direction, startDate, endDate, from) {
    const query = new URLSearchParams({[direction === 'inbound' ? 'To' : 'From']: sender(this.connection, from),
      'DateSent>=': startDate, 'DateSent<=': endDate, PageSize: '100'});
    return `${this.root}/Messages.json?${query}`;
  }
  async page(path) {
    const url = new URL(path, ORIGIN);
    if (url.pathname !== `${this.root}/Messages.json`) throw fail('PROVIDER_RESPONSE', 'Invalid message pagination');
    const value = await this.request(path);
    if (!Array.isArray(value.messages) || value.messages.length > 1000 || !(value.next_page_uri === null || typeof value.next_page_uri === 'string')) throw fail('PROVIDER_RESPONSE', 'Invalid message page');
    if (value.next_page_uri) {
      const next = new URL(value.next_page_uri, ORIGIN);
      if (next.origin !== ORIGIN || next.pathname !== `${this.root}/Messages.json` || !value.next_page_uri.startsWith(`${this.root}/Messages.json?`)) throw fail('PROVIDER_RESPONSE', 'Invalid message pagination');
    }
    return {messages: value.messages, next: value.next_page_uri};
  }
  async get(messageSid) {
    if (!sid(messageSid, '(?:SM|MM)')) throw fail('INVALID_INPUT', 'Invalid Message SID');
    return this.request(`${this.root}/Messages/${messageSid}.json`);
  }
  async create(payload) {
    return this.request(`${this.root}/Messages.json`, {From: payload.from, To: payload.to, Body: payload.text,
      ...(payload.messagingServiceSid ? {MessagingServiceSid: payload.messagingServiceSid} : {})});
  }
  async doctor() {
    const numbers = senders(this.connection);
    for (const from of numbers) {
      const value = await this.request(`${this.root}/IncomingPhoneNumbers.json?${new URLSearchParams({PhoneNumber: from, PageSize: '20'})}`);
      if (!Array.isArray(value.incoming_phone_numbers)) throw fail('PROVIDER_RESPONSE', 'Invalid sender readback');
      const number = value.incoming_phone_numbers.find(row => row.phone_number === from && row.account_sid === this.connection.accountSid);
      if (!number || number.capabilities?.sms !== true) throw fail('SENDER_UNAVAILABLE', 'Configured sender is not an SMS-capable number in this account', 4);
    }
    return {accountSid: this.connection.accountSid, senders: numbers, ...(numbers.length === 1 ? {sender: numbers[0]} : {}), sms: true};
  }
}

async function boundedBody(response) {
  let bytes = 0, result = '';
  const reader = response.body?.getReader();
  if (!reader) throw fail('PROVIDER_RESPONSE', 'Provider response body missing');
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw fail('PROVIDER_RESPONSE', 'Provider response exceeds size limit'); }
      result += decoder.decode(value, {stream: true});
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function message(raw, connection, now = Date.now()) {
  if (!raw || !sid(raw.sid, '(?:SM|MM)') || raw.account_sid !== connection.accountSid ||
      !['inbound', 'outbound-api', 'outbound-call', 'outbound-reply'].includes(raw.direction)) throw fail('PROVIDER_RESPONSE', 'Invalid message identity');
  const from = phone(raw.from), to = phone(raw.to);
  const inbound = raw.direction === 'inbound';
  if (!senders(connection).includes(inbound ? to : from)) throw fail('PROVIDER_RESPONSE', 'Message is outside the configured senders');
  if (typeof raw.body !== 'string' || raw.body.length > 32000 || !Number.isFinite(Date.parse(raw.date_created)) ||
      !/^[a-z_]{1,32}$/.test(raw.status) || !/^\d{1,3}$/.test(String(raw.num_media ?? 0))) throw fail('PROVIDER_RESPONSE', 'Invalid message fields');
  return {id: raw.sid, accountSid: raw.account_sid, from, to, direction: raw.direction, body: raw.body,
    createdAt: new Date(raw.date_created).toISOString(), sentAt: raw.date_sent && Number.isFinite(Date.parse(raw.date_sent)) ? new Date(raw.date_sent).toISOString() : null,
    updatedAt: raw.date_updated && Number.isFinite(Date.parse(raw.date_updated)) ? new Date(raw.date_updated).toISOString() : new Date(raw.date_created).toISOString(),
    capturedAt: new Date(now).toISOString(), status: raw.status, errorCode: Number.isSafeInteger(raw.error_code) ? raw.error_code : null,
    mediaCount: Number(raw.num_media ?? 0), unsupported: Number(raw.num_media ?? 0) > 0};
}

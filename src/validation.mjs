import {fail} from './errors.mjs';

export const sid = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
export function phone(value) {
  if (typeof value !== 'string' || !/^\+[1-9]\d{6,14}$/.test(value)) throw fail('INVALID_INPUT', 'Use an E.164 phone number');
  return value;
}
export function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fail('INVALID_INPUT', `Invalid ${label}`);
  return value;
}
export function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:.-]{1,160}$/.test(value)) throw fail('INVALID_INPUT', 'Use a stable operation key of 1..160 letters, digits, _, :, . or -');
  return value;
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail('INVALID_INPUT', 'Use a UTC ISO timestamp');
  return new Date(value).toISOString();
}
export function config(input, now = Date.now()) {
  const allowed = ['accountSid', 'apiKeySid', 'apiKeySecret', 'authToken', 'sender', 'messagingServiceSid', 'startAt', 'pollSeconds'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !allowed.includes(name))) throw fail('INVALID_INPUT', 'Invalid configuration fields');
  if (!sid(input.accountSid, 'AC')) throw fail('INVALID_INPUT', 'Supply the Twilio Account SID');
  const apiKey = sid(input.apiKeySid, 'SK') && typeof input.apiKeySecret === 'string' && /^[\x21-\x7e]{16,256}$/.test(input.apiKeySecret);
  const token = typeof input.authToken === 'string' && /^[a-fA-F0-9]{32}$/.test(input.authToken);
  if (!(apiKey && input.authToken === undefined || token && input.apiKeySid === undefined && input.apiKeySecret === undefined)) throw fail('INVALID_INPUT', 'Supply an API key pair or an account auth token privately on stdin');
  if (input.messagingServiceSid !== undefined && !sid(input.messagingServiceSid, 'MG')) throw fail('INVALID_INPUT', 'Invalid Messaging Service SID');
  const startAt = timestamp(input.startAt ?? new Date(now).toISOString());
  if (Date.parse(startAt) > now) throw fail('INVALID_INPUT', 'Capture cannot start in the future');
  return {version: 1, accountSid: input.accountSid, sender: phone(input.sender), startAt,
    pollSeconds: integer(input.pollSeconds ?? 60, 15, 3600, 'poll interval'),
    ...(apiKey ? {apiKeySid: input.apiKeySid, apiKeySecret: input.apiKeySecret} : {authToken: input.authToken}),
    ...(input.messagingServiceSid ? {messagingServiceSid: input.messagingServiceSid} : {})};
}
export function sendInput(args, connection) {
  const to = phone(args.to);
  if (to === connection.sender) throw fail('INVALID_INPUT', 'The recipient must differ from the configured sender');
  if (typeof args.text !== 'string' || !args.text.trim() || [...args.text].length > 1600 || /[\u0000\ud800-\udfff]/u.test(args.text)) throw fail('INVALID_INPUT', 'SMS text must contain 1..1600 valid characters');
  return {key: key(args.key), accountSid: connection.accountSid, from: connection.sender, to, text: args.text,
    ...(connection.messagingServiceSid ? {messagingServiceSid: connection.messagingServiceSid} : {})};
}

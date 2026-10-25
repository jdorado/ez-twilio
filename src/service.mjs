import {createServer} from 'node:http';
import {mkdir, readFile, open, rename, unlink, chmod} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from './store.mjs';
import {Transport} from './transport.mjs';
import {config, integer, key, phone} from './validation.mjs';
import {fail, publicError} from './errors.mjs';

export async function serve(options = {}) {
  const directory = options.directory ?? '/state/twilio', socketPath = options.socketPath ?? '/plugins/twilio/service.sock';
  const connectionFile = join(directory, 'connection.json');
  await mkdir(directory, {recursive: true, mode: 0o700});
  // A held SQLite lock is released by the OS on SIGKILL/container death. There
  // is no PID-file lease to expire or stale lock to delete after a restart.
  const writer = new DatabaseSync(join(directory, '.writer.sqlite'), {timeout: 0});
  try { writer.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS writer (id INTEGER);'); }
  catch { writer.close(); throw fail('ALREADY_RUNNING', 'Another plugin service owns this profile'); }
  let store, server;
  try {
  store = new Store(directory);
  let transport, timer, closed = false, errors = 0, writingBackup = false;
  const active = new Set();
  const now = options.now ?? Date.now;
  async function load() {
    let raw;
    try { raw = JSON.parse(await readFile(connectionFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw fail('CORRUPT_STATE', 'Configuration is unreadable; preserve it and investigate'); }
    const {version, ...fields} = raw;
    if (version !== 1) throw fail('CORRUPT_STATE', 'Unsupported configuration schema');
    const connection = config(fields, now());
    store.binding(connection);
    transport = new Transport(store, connection, {now, ...(options.provider ? {provider: options.provider(connection)} : {})});
  }
  await load();
  const required = () => { if (!transport) throw fail('NOT_CONFIGURED', 'Initialize the plugin privately before provider operations', 3); return transport; };
  async function tick() {
    if (closed) return;
    clearTimeout(timer);
    let delay = (transport?.connection.pollSeconds ?? 60) * 1000;
    try {
      if (transport) { const result = await transport.sync(); delay = result.scanComplete ? delay : 1000; }
      errors = 0;
    } catch { errors++; delay = Math.min(300000, delay * 2 ** Math.min(errors, 4)); }
    if (!closed) { timer = setTimeout(() => void tick(), delay); timer.unref(); }
  }
  async function call(command, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_INPUT', 'Expected command arguments');
    if (command === 'health') return {service: 'ready'};
    if (command === 'status') return {configured: Boolean(transport), pollSeconds: transport?.connection.pollSeconds ?? 60, ...store.status()};
    if (command === 'init') {
      const prior = transport?.connection;
      const connection = config({...args.configuration, ...(args.configuration?.startAt === undefined && prior ? {startAt: prior.startAt} : {})}, now());
      store.binding(connection);
      await atomicPrivate(connectionFile, connection);
      transport = new Transport(store, connection, {now, ...(options.provider ? {provider: options.provider(connection)} : {})});
      clearTimeout(timer); timer = setTimeout(() => void tick(), 0);
      return {configured: true, accountSid: connection.accountSid, sender: connection.sender, startAt: connection.startAt, pollSeconds: connection.pollSeconds};
    }
    if (command === 'inbox') return store.inbox(integer(args.after ?? 0,0,Number.MAX_SAFE_INTEGER,'cursor'), integer(args.limit ?? 20,1,100,'limit'), args.generation);
    if (command === 'acknowledge') return store.acknowledge(key(args.consumer), integer(args.cursor,0,Number.MAX_SAFE_INTEGER,'cursor'), args.generation);
    if (command === 'operation') {
      const operation = store.operation(key(args.key));
      if (!operation) throw fail('NOT_FOUND', 'Operation not found');
      return operation;
    }
    if (command === 'backup') {
      if (writingBackup) throw fail('BUSY', 'A consistent backup is already running');
      writingBackup = true;
      try { return await store.backup(); } finally { writingBackup = false; }
    }
    if (command === 'recovery-acknowledge') {
      key(args.reference);
      if (!store.meta('recovery')) return {reconciled: true};
      if (store.meta('scan') || !store.meta('coverage') || Date.parse(store.meta('coverage').completedThrough) < now() - 120000) throw fail('RESTORE_REVIEW', 'Complete capture catch-up before acknowledging restore reconciliation', 4);
      store.setMeta('recoveryAcknowledgment', {reference: args.reference, at: new Date(now()).toISOString()});
      store.setMeta('recovery', null);
      return {reconciled: true, reference: args.reference};
    }
    const current = required();
    if (command === 'doctor') return {...await current.provider.doctor(), configured: true, polling: true, pollSeconds: current.connection.pollSeconds, ...store.status()};
    if (command === 'sync') return current.sync(args.maxPages ?? 20);
    if (command === 'message') return current.refresh(args.id);
    if (command === 'send') return current.send(args);
    if (command === 'events-head') return {cursor: store.head(), accountId: current.accountId(), taskProtocol: 'message-v1', persistentWatch: true, releaseEvents: true};
    if (command === 'events') return current.events(args.after);
    if (command === 'events-check') return current.check(args.ids);
    if (command === 'events-release') { current.check(args.ids); return store.release(args.ids); }
    if (command === 'task-watch') return current.watch(args);
    if (command === 'task-unwatch') { current.checkAccount(args); return store.unwatch(phone(args.conversationId)); }
    if (command === 'task-send') return current.taskSend(args);
    throw fail('INVALID_INPUT', 'Unknown command; read --help');
  }
  await mkdir(dirname(socketPath), {recursive: true, mode: 0o700});
  // Listening first is the writer lock. Never unlink a socket owned by a live service.
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method !== 'POST' || request.url !== '/') throw fail('INVALID_INPUT', 'POST / required');
      let body = '';
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 65536) throw fail('INVALID_INPUT', 'Request exceeds size limit'); }
      let input;
      try { input = JSON.parse(body); } catch { throw fail('INVALID_INPUT', 'Expected JSON'); }
      if (Object.keys(input).some(name => !['command','args'].includes(name))) throw fail('INVALID_INPUT', 'Invalid request fields');
      const operation = call(input.command, input.args ?? {});
      active.add(operation);
      let data;
      try { data = await operation; } finally { active.delete(operation); }
      response.end(JSON.stringify({ok: true, data}));
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ok: false, error: publicError(error)})); }
  });
  server.requestTimeout = 15000;
  // Only the profile's exclusive writer can remove its old socket.
  await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(socketPath,resolve); });
  await chmod(socketPath, 0o600);
  timer = setTimeout(() => void tick(), 0);
  return {store, call, socketPath, close: async () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    server.close(); server.closeAllConnections();
    await transport?.pendingSync?.catch(() => {});
    await Promise.allSettled([...active]);
    // A send in progress already has a durable uncertain reservation.
    store.close();
    writer.exec('ROLLBACK'); writer.close();
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }};
  } catch (error) {
    server?.close();
    store?.close();
    writer.close();
    throw error;
  }
}

async function atomicPrivate(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
}

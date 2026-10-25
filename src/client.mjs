import {request} from 'node:http';
import {fail} from './errors.mjs';

export function client(socketPath, command, args = {}) {
  return new Promise((resolve,reject) => {
    const req = request({socketPath, path: '/', method: 'POST', timeout: 30000}, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 4 * 1024 * 1024) req.destroy(); });
      response.on('error', () => reject(fail('SERVICE_UNAVAILABLE', 'Plugin response interrupted; inspect the existing operation for a send', 5)));
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.ok !== true) throw Object.assign(new Error(result.error.message), result.error, {details: result.error});
          resolve(result.data);
        } catch (error) { reject(error?.exitCode ? error : fail('SERVICE_UNAVAILABLE', 'Plugin response unavailable; inspect the existing operation for a send', 5)); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(fail('SERVICE_UNAVAILABLE', 'Plugin service unavailable; use the registered Docker lifecycle', 5)));
    req.end(JSON.stringify({command,args}));
  });
}

#!/usr/bin/env node
import {main} from '../src/cli.mjs';
import {publicError} from '../src/errors.mjs';

try {
  const result = await main(process.argv.slice(2));
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const output = publicError(error);
  process.stderr.write(`${JSON.stringify({error: output})}\n`);
  process.exitCode = output.exitCode;
}

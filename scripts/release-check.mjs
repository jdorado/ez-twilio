import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';

const pkg=JSON.parse(readFileSync('package.json','utf8'));
const manifest=JSON.parse(readFileSync('ez-plugin.json','utf8'));
assert.equal(manifest.version,pkg.version);
assert.equal(pkg.name,'@jc_stack/ez-twilio');
const [pack]=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{encoding:'utf8'}));
const files=pack.files.map(file=>file.path);
for(const required of ['LICENSE','THIRD_PARTY_NOTICES.md','README.md','SECURITY.md','CONTRIBUTING.md','CHANGELOG.md','Dockerfile','.dockerignore','ez-plugin.json','ez-deployment.json','docker/pnpm-lock.yaml','bin/ez-twilio.mjs','skills/twilio/SKILL.md']) assert(files.includes(required),`Missing ${required}`);
if(existsSync('pnpm-lock.yaml'))assert.equal(readFileSync('docker/pnpm-lock.yaml','utf8'),readFileSync('pnpm-lock.yaml','utf8'),'Packed lockfile must match the source lock');
for(const file of files) assert(!/(^|\/)(node_modules|\.git|\.env|\.private)(\/|$)|\.(tgz|sqlite|log)$/.test(file),`Private package entry: ${file}`);
assert.equal((await import('../src/cli.mjs')).main instanceof Function,true);
console.log(JSON.stringify({name:pkg.name,version:pkg.version,files:files.length}));

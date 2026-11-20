import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function wrangler(args, capture = false) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? '';
}

const path = new URL('../wrangler.jsonc', import.meta.url);
const config = JSON.parse(readFileSync(path, 'utf8'));
const database = config.d1_databases[0];
if (database.database_id === '00000000-0000-0000-0000-000000000000') {
  console.log(`Creating database ${database.database_name}…`);
  const output = wrangler(['d1', 'create', database.database_name], true);
  const match = output.match(/(?:"database_id"\s*:\s*"|database_id\s*=\s*")([a-f0-9-]{36})"/);
  if (!match) {
    console.error('The database was created, but its ID could not be read. Set database_id in wrangler.jsonc from the Cloudflare dashboard, then run npm run deploy again.');
    process.exit(1);
  }
  database.database_id = match[1];
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
wrangler(['deploy']);

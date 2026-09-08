import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('artifact', { recursive: true });

const banner = `import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);`;

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: banner },
  external: [
    'kerberos',
    'snappy',
    'socks',
    'aws4',
    '@aws-sdk/credential-providers',
    '@mikro-orm/knex',
    '@mikro-orm/sqlite',
    '@mikro-orm/postgresql',
    '@mikro-orm/mysql',
    '@google-cloud/storage',
    '@google-cloud/opentelemetry-cloud-monitoring-exporter',
    '@google-cloud/opentelemetry-cloud-trace-exporter',
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@mikro-orm/core': './build/stubs/mikro-orm-core.mjs' },
};

await build({ ...shared, entryPoints: ['src/lambda/api.ts'], outfile: 'artifact/api.mjs' });
await build({ ...shared, entryPoints: ['src/lambda/worker.ts'], outfile: 'artifact/worker.mjs' });
console.log('esbuild: artifact/api.mjs + artifact/worker.mjs written');

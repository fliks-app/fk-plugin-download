import * as esbuild from 'esbuild';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MANIFEST_TEMPLATE } from './manifest-template';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function build(): void {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/plugin.ts')],
    outfile: path.join(DIST, 'plugin.js'),
    bundle: true,
    minify: false,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    legalComments: 'none',
  });

  fs.copyFileSync(path.join(ROOT, 'logo.svg'), path.join(DIST, 'logo.svg'));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };

  const manifest = {
    ...MANIFEST_TEMPLATE,
    version: pkg.version,
    files: {
      'plugin.js': sha256(path.join(DIST, 'plugin.js')),
      'logo.svg': sha256(path.join(DIST, 'logo.svg')),
    },
  };

  fs.writeFileSync(path.join(DIST, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
}

if (require.main === module) {
  build();
  console.log('built dist/plugin.js, dist/plugin.json, dist/logo.svg');
}

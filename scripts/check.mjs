#!/usr/bin/env node
// Repo self-check: the invariants that no unit test can see because they live
// in the packaging, not the behaviour. Runs with zero dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

/** @param {boolean} ok @param {string} message */
function expect(ok, message) {
  if (!ok) failures.push(message);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 1. Every shipped path exists. `files` is what npm actually tars up, so a typo
//    here silently drops files from the published package.
for (const entry of pkg.files ?? []) {
  const pattern = entry.replace(/^\.\//, '');
  if (pattern.includes('*')) {
    const [dir, tail] = pattern.split('/');
    const suffix = tail.replace('*', '');
    const found = existsSync(join(root, dir))
      && readdirSync(join(root, dir)).some((name) => name.endsWith(suffix));
    expect(found, `files entry "${entry}" matches nothing`);
  } else {
    expect(existsSync(join(root, pattern)), `files entry "${entry}" does not exist`);
  }
}

// 2. The README points at this package on npm by name: a rename cannot leave a
//    badge quietly linking to somebody else's package.
const readme = readFileSync(join(root, 'README.md'), 'utf8');
expect(readme.includes(`img.shields.io/npm/v/${pkg.name}`), `README has no npm badge for ${pkg.name}`);

// 3. The Client module id is the package name; the loader keys plugins by it.
const client = readFileSync(join(root, 'client.js'), 'utf8');
const id = /id:\s*'([^']+)'/.exec(client);
expect(id !== null, 'client.js has no module id');
if (id !== null) expect(id[1] === pkg.name, `client.js module id "${id[1]}" is not "${pkg.name}"`);

// 4. The bundle patch inserts the same module name, or the row points at nothing.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
expect(patch.includes(`name: '${pkg.name}'`), `cordis.patch.yml does not register "${pkg.name}"`);

// 5. Both dictionaries carry the same key set, so nothing renders as a raw key.
const dictionaries = [...client.matchAll(/const (zh|en) = \{([\s\S]*?)\n\t\t\};/g)];
expect(dictionaries.length === 2, 'expected one zh and one en dictionary');
if (dictionaries.length === 2) {
  const keys = Object.fromEntries(dictionaries.map(([, lang, body]) => [
    lang,
    new Set([...body.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1])),
  ]));
  for (const key of keys.zh) expect(keys.en.has(key), `en is missing "${key}"`);
  for (const key of keys.en) expect(keys.zh.has(key), `zh is missing "${key}"`);
}

// 6. Every JavaScript file parses. A syntax error in a file no test imports
//    would otherwise only surface in the browser.
for (const file of ['client.js', 'index.js', 'scripts/check.mjs', 'test/peak.test.mjs']) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`${file} does not parse: ${error.message.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✖ ${failure}`);
  process.exit(1);
}
console.log(`✔ ${pkg.name}@${pkg.version}: packaging, dictionaries, and syntax agree`);

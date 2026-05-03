#!/usr/bin/env node
// Bootstrap outputs/tasks.json on a fresh clone.
// Copies outputs/tasks.template.json -> outputs/tasks.json (only if missing),
// stamps the current ISO timestamp into lastUpdated, and ensures patches/ exists.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const templatePath = resolve(root, 'outputs/tasks.template.json');
const targetPath = resolve(root, 'outputs/tasks.json');
const patchesDir = resolve(root, 'outputs/patches');

if (!existsSync(templatePath)) {
  console.error(`✗ template missing: ${templatePath}`);
  process.exit(1);
}

mkdirSync(patchesDir, { recursive: true });

if (existsSync(targetPath)) {
  console.log(`✓ outputs/tasks.json already exists — skipping (delete it to re-bootstrap)`);
  process.exit(0);
}

const tpl = JSON.parse(readFileSync(templatePath, 'utf8'));
tpl.lastUpdated = new Date().toISOString();
writeFileSync(targetPath, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
console.log(`✓ created ${targetPath} from template`);

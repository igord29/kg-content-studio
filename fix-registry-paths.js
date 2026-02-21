#!/usr/bin/env node
/**
 * fix-registry-paths.js
 *
 * Watches src/generated/registry.ts during agentuity build and fixes
 * Windows backslash paths in import statements.
 *
 * The Agentuity CLI on Windows generates import paths with backslashes:
 *   import foo from 'src\agent\video-editor\index.ts';
 * which are invalid (backslashes are escape chars in JS strings).
 *
 * Additionally, the path conversion from src/agent/... to ../agent/...
 * never fires on Windows because the regex expects forward slashes.
 *
 * This script:
 * 1. Replaces backslashes with forward slashes
 * 2. Converts src/agent/X to ../agent/X (the correct relative path)
 * 3. Converts .ts/.tsx extensions to .js
 */

import { watch, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const registryPath = join(process.cwd(), 'src', 'generated', 'registry.ts');
const watchDir = dirname(registryPath);

function fixImportPath(importPath) {
  // Step 1: Normalize backslashes to forward slashes
  let fixed = importPath.replace(/\\/g, '/');
  // Step 2: Convert src/agent/X to ../agent/X
  if (fixed.startsWith('src/agent/')) {
    fixed = fixed.replace(/^src\/agent\//, '../agent/');
  }
  // Step 3: Convert .ts/.tsx to .js
  fixed = fixed.replace(/\.tsx?$/, '.js');
  return fixed;
}

function fixRegistryFile() {
  if (!existsSync(registryPath)) return false;
  const content = readFileSync(registryPath, 'utf-8');

  // Check if file needs fixing (has backslash paths or unconverted src/agent paths)
  const needsFix = content.includes('src\\agent') ||
    (content.includes("from 'src/agent") && content.includes('.ts'));

  if (!needsFix) return false;

  // Fix import paths in both forms:
  //   import foo from 'path';
  //   import 'path';
  const fixed = content
    .replace(/from '([^']+)'/g, (match, p) => "from '" + fixImportPath(p) + "'")
    .replace(/import '([^']+)'/g, (match, p) => "import '" + fixImportPath(p) + "'");

  if (fixed !== content) {
    writeFileSync(registryPath, fixed, 'utf-8');
    console.log('[fix-registry] Fixed Windows paths in registry.ts');
    return true;
  }
  return false;
}

// Fix immediately if file already exists
fixRegistryFile();

// Start watching for changes
let debounceTimer = null;
const watcher = watch(watchDir, { recursive: false }, (eventType, filename) => {
  if (filename === 'registry.ts') {
    // Debounce to avoid double-writes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fixRegistryFile();
    }, 50);
  }
});

// Determine which agentuity command to run (build or deploy)
const args = process.argv.slice(2);
let command = 'build';
const filteredArgs = [];
for (const arg of args) {
  if (arg === 'deploy' || arg === 'build') {
    command = arg;
  } else {
    filteredArgs.push(arg);
  }
}
const buildArgs = ['@agentuity/cli', command, ...filteredArgs];
console.log(`[fix-registry] Starting agentuity ${command} with path watcher...`);

const child = spawn('bunx', buildArgs, {
  stdio: 'inherit',
  shell: true,
  cwd: process.cwd(),
});

child.on('close', (code) => {
  watcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  process.exit(code);
});

child.on('error', (err) => {
  console.error('[fix-registry] Failed to start build:', err.message);
  watcher.close();
  process.exit(1);
});

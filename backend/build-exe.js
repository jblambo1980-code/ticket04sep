'use strict';

// Builds the packaged Windows desktop app into ../dist.
//
//   node build-exe.js
//
// Produces:  dist/CineBook.exe                (the launcher)
//            dist/better_sqlite3.node          (native SQLite addon, loaded at runtime)
//
// Ship BOTH files together (see docs/PACKAGING.md).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const backendDir = __dirname;
const repoRoot = path.join(backendDir, '..');
const distDir = path.join(repoRoot, 'dist');
const target = process.env.PKG_TARGET || 'node22-win-x64';
const exePath = path.join(distDir, 'CineBook.exe');

const prebuilt = path.join(
  backendDir,
  'node_modules',
  'better-sqlite3',
  'prebuilds',
  'win32-x64.node'
);

function run() {
  if (!fs.existsSync(prebuilt)) {
    throw new Error(
      `Missing ${prebuilt}. Run "npm install" in backend/ first (needs the win32-x64 prebuild).`
    );
  }

  fs.mkdirSync(distDir, { recursive: true });

  const pkgBin = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');

  console.log(`Packaging CineBook for ${target} ...`);
  execFileSync(
    process.execPath,
    [
      pkgBin,
      'pkg-entry.js',
      '--targets',
      target,
      '--config',
      'package.json',
      '--output',
      exePath,
      '--compress',
      'GZip',
    ],
    { cwd: backendDir, stdio: 'inherit' }
  );

  // better-sqlite3's addon is loaded from disk at runtime; ship it beside the exe.
  const addonOut = path.join(distDir, 'better_sqlite3.node');
  fs.copyFileSync(prebuilt, addonOut);

  const size = (fs.statSync(exePath).size / (1024 * 1024)).toFixed(1);
  console.log('');
  console.log(`  Built: ${exePath} (${size} MB)`);
  console.log(`  Built: ${addonOut}`);
  console.log('  Ship both files together. Details in docs/PACKAGING.md.');
}

run();

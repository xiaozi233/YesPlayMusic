#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 一键构建当前平台的桌面安装包。
 *
 * 用法：
 *   npm run build:app
 *   node scripts/build-app.js
 *
 * 做的事：
 *   1. 补齐 .env（缺失时从 .env.example 复制）
 *   2. 缺失时安装依赖 / 下载 Electron 二进制
 *   3. Node 17+ 自动加 --openssl-legacy-provider（Webpack 4 需要）
 *   4. 调用 electron-builder 打包
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);

const target = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
if (!target) {
  console.error(`[build] 不支持的平台: ${process.platform}`);
  process.exit(1);
}

function log(message) {
  console.log(`\n[build] ${message}`);
}

function fail(message, code = 1) {
  console.error(`\n[build] ${message}`);
  process.exit(code);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
let nodeOptions = process.env.NODE_OPTIONS || '';
if (nodeMajor >= 17 && !nodeOptions.includes('--openssl-legacy-provider')) {
  nodeOptions = `${nodeOptions} --openssl-legacy-provider`.trim();
}

function run(command, args) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    fail(`命令失败（退出码 ${result.status}）：${command} ${args.join(' ')}`);
  }
}

// 1. .env
if (!fs.existsSync('.env')) {
  if (!fs.existsSync('.env.example')) fail('缺少 .env.example');
  fs.copyFileSync('.env.example', '.env');
  log('已从 .env.example 创建 .env');
}

// 2. 依赖
if (!fs.existsSync('node_modules')) {
  log('未找到 node_modules，开始安装依赖');
  run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund']);
}

// 3. Electron 二进制（--ignore-scripts 安装时可能缺失）
const electronBinary =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : 'node_modules/electron/dist/electron';
if (!fs.existsSync(electronBinary)) {
  log('Electron 二进制缺失，开始下载');
  run('node', ['node_modules/electron/install.js']);
}

// 4. Windows 原生 UNM 模块（与 CI 保持一致）
if (process.platform === 'win32') {
  const nativePkg = 'node_modules/@unblockneteasemusic/rust-napi-win32-x64-msvc';
  if (!fs.existsSync(nativePkg)) {
    const rustNapiPackage = 'node_modules/@unblockneteasemusic/rust-napi/package.json';
    if (fs.existsSync(rustNapiPackage)) {
      const version = require(path.resolve(rustNapiPackage)).version;
      log(`安装 Windows 原生模块 @unblockneteasemusic/rust-napi-win32-x64-msvc@${version}`);
      run('npm', [
        'install',
        '--no-save',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        `@unblockneteasemusic/rust-napi-win32-x64-msvc@${version}`,
      ]);
    }
  }
}

// 5. 打包
run('npm', ['run', `electron:build-${target}`]);

const outputs = {
  win32: ['dist_electron/win-unpacked/YesPlayMusic.exe'],
  darwin: ['dist_electron/mac/YesPlayMusic.app'],
  linux: ['dist_electron/YesPlayMusic-*.AppImage'],
};
log('构建完成，产物：');
for (const output of outputs[process.platform]) {
  console.log(`  ${path.join(root, output)}`);
}

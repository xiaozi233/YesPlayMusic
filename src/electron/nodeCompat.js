/* global globalThis */
/**
 * Electron 13 内置 Node 14.16，而新版网易云 API 包（express 5 / jsdom）
 * 用到了一些更新的 Node API。这里只补齐启动必需的最小集合，
 * 让 API 服务能正常跑在主进程里。
 *
 * 该文件必须在 require('@neteasecloudmusicapienhanced/api/**') 之前执行。
 */
const Module = require('module');

// require('node:xxx') 前缀是 Node 14.18+/16 才支持的
if (!Module._resolveFilename.__nodePrefixPatched) {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (typeof request === 'string' && request.startsWith('node:')) {
      request = request.slice(5);
    }
    return originalResolveFilename.call(this, request, ...args);
  };
  Module._resolveFilename.__nodePrefixPatched = true;
}

// Object.hasOwn: Node 16.9+
if (typeof Object.hasOwn !== 'function') {
  Object.hasOwn = (object, property) =>
    Object.prototype.hasOwnProperty.call(object, property);
}

// Array.prototype.at: Node 16.6+
if (typeof Array.prototype.at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', {
    value: function at(index) {
      const position = Math.trunc(index) || 0;
      return this[position < 0 ? this.length + position : position];
    },
    writable: true,
    configurable: true,
  });
}

// String.prototype.replaceAll: Node 15+
if (typeof String.prototype.replaceAll !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAll', {
    value: function replaceAll(search, replacement) {
      return this.split(search).join(replacement);
    },
    writable: true,
    configurable: true,
  });
}

// structuredClone: Node 17+
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
}

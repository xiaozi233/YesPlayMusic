import clc from 'cli-color';
// 必须在加载新版 API 包之前执行（Electron 13 的 Node 14 缺少部分新 API）
import './nodeCompat';
// 仅为了副作用：确保 anonymous_token 文件存在
import '../utils/checkAuthToken';

/**
 * 新版 API 包（@neteasecloudmusicapienhanced/api）依赖 jsdom，
 * 它下面的 @csstools/* 是 Webpack 4 无法解析的 ESM。
 * 主进程 bundle 里要用运行时 require，让 Node 直接从 node_modules 解析，
 * 而不是把整棵依赖树塞进 bundle。
 * @see src/ncmModDef.js 使用同样的写法
 */
/* global __non_webpack_require__ */
const nodeRequire =
  typeof __non_webpack_require__ === 'function'
    ? __non_webpack_require__
    : require;

export async function startNeteaseMusicApi() {
  // Let user know that the service is starting
  console.log(`${clc.redBright('[NetEase API]')} initiating NCM API`);

  const server = nodeRequire('@neteasecloudmusicapienhanced/api/server');

  // Load the NCM API.
  await server.serveNcmApi({
    port: 10754,
    moduleDefs: require('../ncmModDef'),
  });
}

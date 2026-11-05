# 无缝播放实现说明（Gapless Playback）

对照 `AGENT_PROMPT_GAPLESS.md` 的实现记录。代码尚未 commit。

## 1. 改动文件与职责

| 文件 | 职责 |
|---|---|
| `src/utils/AudioEngine.js`（新增） | 播放内核：单一 `AudioContext`、默认直连输出、指定设备的按需桥接、预解码、绝对时刻排程、暂停/继续、seek；保留完整解码样本 |
| `src/utils/Player.js` | 引擎接入、预取与重新排程、播放请求代际检查、播放意图、边界 UI 同步、scrobble、进度、Howler 降级 |
| `src/utils/db.js` | 缓存音源标签、复用已下载字节；歌曲详情通过 `bulkGet()` 按主键读取，避免全表扫描 |
| `src/api/track.js` | 详情缓存未命中时复用后台请求，避免重复请求；处理后台刷新失败 |
| `src/utils/playerStateProxy.js`（新增）、`src/store/index.js` | 运行时字段变化不再持久化；同一轮状态变化合并保存，卸载窗口前同步落盘 |
| `src/electron/playbackState.js`（新增）、退出入口 | 主进程退出前请求渲染进程保存实时歌曲/位置，再刷新 Chromium 存储 |
| `src/store/initLocalStorage.js` | 新增 `gaplessPlayback: true`、`playPauseFade: false` |
| `src/views/settings.vue` | 「无缝播放」开关（仅 Electron）及「播放 / 暂停淡入淡出」开关；淡变默认关闭 |
| `src/components/Player.vue` | 音源标签改用 `player.currentSourceLabel`（Web Audio 模式没有 `_howler`） |
| `src/electron/ipcRenderer.js` | MPRIS `setPosition` 改走 `player.seek()` |
| `src/locale/lang/*.js` | 设置项与登录相关文案 |

## 2. 调度时钟与边界推进

- 无缝播放使用一个懒创建的 `AudioContext`，默认设备直连 `ctx.destination`，不经过 MediaStream/HTMLAudioElement 的第二层缓冲与实时流追赶。切歌只停止旧 source；清理 Howler 时仅卸载当前 Howl，不再调用会重建全局 AudioContext 的 `Howler.unload()`。
- 当前曲：`source.start(startAt, offset)`；`cursor = startAt + duration - offset`。
- 下一首：`source.start(cursor)`，与上一首结束时刻**完全相等**（实测差值 = 0 采样）。
- 播放时间的唯一真源是 `ctx.currentTime`；`position = offset + (currentTime - startAt)`。
- 边界推进用 50ms tick 比较 `ctx.currentTime`，实际到达排程时刻后才把 `upcoming` 提升为 `current` 并回调 `Player._handleTrackStart()`。音频衔接由已排程的 source 完成，UI 轮询不会决定音频开始时刻。
- 暂停/继续：默认直接暂停、恢复；「设置 → 播放 / 暂停淡入淡出」开启后使用 200ms 音量渐变，两种播放后端均支持。自然曲目边界不叠加淡变。
- 暂停保存当前位置并停止当前/下一首的 source，保留 AudioBuffer，AudioContext 时钟持续运行。恢复时从保存的 offset 创建 source，并按剩余时长重排下一首。指定设备的桥在暂停时断开、停止全部 MediaStreamTrack 并解除 `srcObject`，恢复时创建新的消费者，避免消费旧实时流缓冲；默认设备始终没有这层桥。
- 手动切歌与预取共用 `_prepareTrack()`，复用已经解码的下一首和正在进行的准备任务。最近解码结果按曲目 ID 与音质复用，LRU 最多 3 项、累计 PCM 大小最多 128MiB（引擎当前/下一首自身保留的 buffer 另计）。选中不同曲目时取消过期下载；不可取消的旧解码结果通过请求代际与取消标记丢弃。
- 启动排程余量为 10ms，使用 `interactive` 延迟提示。尚未缓存、预取的任意新曲仍需完整下载并解码，不能保证秒开。
- Player 的非枚举运行时字段不再触发整个播放列表的 JSON 序列化。可持久化变化用一次定时任务合并保存，并在窗口卸载前同步提交最后的状态。万首列表的模拟切歌中，开始排程音频前的同步保存从 15 次变为 0 次；随后合并为一次保存。此测试模拟下载/解码，不能代表真实联网切歌总耗时。
- 预取：当前曲加载完成后立即预取下一首（含单曲循环复用同一 `AudioBuffer`）；`_prefetchGen` 丢弃过期解码结果。循环、随机、倒序和队列编辑统一走 `_refreshUpcoming()`，取消旧排程后立即补充新曲；切歌、seek 和关闭开关只取消旧排程，再由对应流程决定何时补充。
- 单曲循环、随机、`playNextList`、私人 FM 的队列下标推进都在边界回调里完成（`_scheduledNextIndex`），避免 UI 提前切歌。

## 3. 降级策略

- `gaplessPlayback === false`、`AudioContext` 不可用、取音频失败、解码失败 → 回落 Howler。统一在 `_playAudioSource()` 设置模式、恢复音量并取消 Web Audio 排程，控制和进度始终对应实际后端。
- 回落前先 `engine.clearAllSources()`，避免两套输出叠加；`_audioMode` 按曲目切换，下一首仍会重新尝试 Web Audio。
- 边界处预取未赶上（`onGap('no-upcoming')`）→ 走原 `_nextTrackCallback()` 逻辑。
- Web 构建：Axios 下载受 CORS 限制或浏览器没有 AudioContext 时自动降级。
- `_engine`、`_audioMode`、`_prefetched` 等字段全部 `enumerable: false`，不会进 localStorage，也不会被 Vue 观察成响应式对象。

## 4. 解码样本与编码器填充

已移除按首尾「精确 0」推断填充的裁剪逻辑。这种做法会删除音乐本身的静音，
也不能可靠识别有损编码的 delay/padding。

Electron 13.6.9 / Chromium 91 对本仓库带 Xing/LAME 标签的 MP3 测试素材，
已能根据编码元数据返回原始 48000 个有效样本；引擎完整保留这个结果。
缺少有效编码元数据的文件不做猜测裁剪，不能保证消除文件自身携带的填充。

## 5. 可重复验证（2026-11-05）

`tests/gapless-playback.test.js` 使用实际 Player、AudioEngine、缓存模块，模拟网络、
音频时钟与浏览器边界。54 个场景覆盖全部 8 项审阅问题，以及 A-B-A 乱序切歌、
连续 FM、过期降级、加载期间暂停、seek、列表末尾停止和缓存字节复用。
另覆盖手动下一首复用已解码/进行中的任务、长时间暂停后的重排、跨边界淡出、
连续恢复不重复创建 source，以及两个后端的直接暂停与可选淡变。
另验证默认直连、指定设备桥的释放/重建与过期请求、批量持久化、最近解码复用与
缓存内存上限、取消过期下载、详情请求复用和 IndexedDB 主键查询。
恢复相关测试还覆盖歌曲/进度关联、加载时退出、旧恢复请求、启动离线重试、FM 补充数据、
Howler 尚未加载完成的初始 seek、无待保存变更时退出，以及退出前的保存/刷盘顺序。

`tests/gapless-audio.electron.js` 在 Electron 13.6.9 / Chromium 91.0.4472.164 中，
通过实际 `decodeAudioData()` 和引擎排程进行离线渲染，并与合成波形逐样本比较。

| 指标 | 结果 |
|---|---|
| 44.1kHz / 48kHz、双声道 WAV 排程边界误差 | **0 采样** |
| 两段 WAV 拼接后的最大逐样本误差 | **0** |
| 素材首尾的真实静音 | **2000 个样本完整保留** |
| 带 Xing/LAME 标签的 1s / 48kHz MP3 | **48000 个有效样本** |
| 实时 AudioContext | 暂停取消、播放位置固定而输出时钟继续、下一首重排、暂停 seek 与恢复均通过 |
| 默认设备输出 | 直连 AudioContext，无 MediaStream sink；连续暂停/恢复后 997Hz 测试音为 996.91–997.09Hz，`getOutputTimestamp()` 测得输出时钟比例约 **0.99994×** |
| 指定设备输出路径 | 实际 HTMLAudioElement/MediaStream 连续 3 次暂停/恢复，旧流全部结束、旧 srcObject 释放、恢复时创建新消费者；最后恢复默认直连 |

频率通过测试专用的 MediaRecorder 分支测量，时钟比例使用真实输出时间戳；没有采集物理声卡/蓝牙回环。
指定设备路径的原生测试将测试设备 ID 映射到系统默认目标，保留真实桥接生命周期；尚未验证另一张物理声卡。
上一版只测了生产端的音频流，未覆盖消费端，无法据此排除用户报告的倍速；本版移除默认设备的第二层消费者并重置指定设备的旧流，但仍需用户设备上的最终听感验证。

运行方式（无需新增依赖）：

```sh
npm run test:gapless
npm run test:gapless:audio
npm run test:playback:restore
```

本机没有 Yarn，使用已安装的 Vue CLI 直接完成全仓库 lint 和 Web build。
Node 24 构建旧 Webpack 4 时需要设置 `NODE_OPTIONS=--openssl-legacy-provider`。

## 6. 验收清单状态

已通过静态/自动化验证：

- [x] Vue CLI `lint --no-fix`（0 error，9 个已有 warning）
- [x] Vue CLI `build`（Web 构建成功，已有 CSS 顺序和包体积警告）
- [x] `npm run build:app`（Windows 免安装目录、便携版、安装版已更新，app.asar 已核对包含本轮播放改动）
- [x] `ncmModDef` 全部 124 个模块在切换后的 API 包下可加载（此前验证，本轮未重测）
- [x] `startNeteaseMusicApi()` 实际启动成功：`/login/qr/key` 返回 200、`/song/detail` 正常（此前验证，本轮未重测）
- [x] 54 个回归场景、原生解码/渲染、边界推进、seek/pause/resume、直接输出时钟和自定义输出桥生命周期（上述数据）
- [x] 独立临时配置的 4 个 Electron 进程依次启动/正常退出，实际 localStorage 落盘；Web Audio / Howler 恢复歌曲、队列下标、精确 offset 并从该位置播放

需要在 GUI 内人工确认的项（未在本环境联网登录实测）：

- [ ] `yarn electron:serve` 完整窗口：本机 dev server 编译通过，但 Electron 主进程
  未在超时内拉起（插件没有输出启动日志），因此未验证窗口内表现
- [ ] 实际播放/暂停/进度条/上一首下一首/随机/单曲循环
- [ ] 私人 FM、`fmTrash`、列表末尾停止
- [ ] MPRIS / 媒体键 / 托盘 / 标题、Discord Presence、Last.fm
- [ ] 输出设备切换（MediaStream 桥接）
- [ ] 无网络/灰歌的 toast 与自动下一首

## 7. 登录问题修复（issue #2493）

根因：`@neteaseapireborn/api` 已废弃，其 4.29.13 只是 `@neteasecloudmusicapienhanced/api`
的转发壳（没有 `module/` 目录），而旧版 4.29.7 的二维码接口仍走老链路，
被网易云风控拦截为 `-462` / `8821`。

改动：

1. 依赖切换到 `@neteasecloudmusicapienhanced/api@^4.41.1`；同步
   `src/ncmModDef.js`、`src/electron/services.js`、`src/electron/scrobble.js`、`yarn.lock`。
   新包的二维码接口使用 `interface.music.163.com` + `type=3`。
2. `src/views/loginAccount.vue`：
   - 二维码 key 失败时停止轮询并展示原因（旧代码会静默轮询直到超时）；
   - 显式处理 `-460 / -462 / 8810 / 8821 / 8822`，提示关闭代理/VPN、换登录方式或使用 Cookie；
   - 新增「Cookie 登录」：支持粘贴完整 Cookie 或仅 `MUSIC_U`，用 `/user/account` 校验后落库。
3. 4 种语言的文案。

验证（本机网络）：

```
GET /login/qr/key   -> {"code":200,"unikey":"..."}      （旧链路为 -462）
GET /login/qr/check -> {"code":801,"message":"等待扫码"}
```

> 若网络 IP 本身已被风控，二维码仍可能被拒；此时界面会明确提示并引导到 Cookie 登录，
> 不再出现「扫码后一直卡住、无任何反馈」。

## 8. 一键构建（Windows）

```sh
npm run build:app          # 或双击仓库根目录的 build-app.cmd
```

脚本 `scripts/build-app.js` 会补齐 `.env`、检查依赖/Electron 二进制、
Node 17+ 自动加 `--openssl-legacy-provider`，然后调用 electron-builder。产物：

```
dist_electron/win-unpacked/YesPlayMusic.exe        # 免安装，双击即用
dist_electron/YesPlayMusic 0.4.11.exe              # 便携版
dist_electron/YesPlayMusic Setup 0.4.11.exe        # 安装版
```

打包过程中修掉的两个兼容性问题：

1. **Webpack 4 解析不了新版 API 的 ESM 依赖**（jsdom → `@csstools/*`）。
   `ncmModDef.js` / `services.js` 改用运行时 require，并在 `vue.config.js`
   的 `electronBuilder.externals` 中声明 `@neteasecloudmusicapienhanced/api`，
   否则插件会把它当作“已打进 bundle”而从打包依赖里剔除。
2. **Electron 13 内置 Node 14.16**，新版 API（express 5 / jsdom）用到
   `Object.hasOwn`、`Array.prototype.at`、`String.prototype.replaceAll`、
   `structuredClone` 和 `require('node:xxx')`。`src/electron/nodeCompat.js`
   补齐这些 API，并在加载 API 包之前导入。

验证：打包后的 `win-unpacked/YesPlayMusic.exe` 可正常启动，
内置服务 `http://127.0.0.1:27232/api/login/qr/key` 返回 `{"code":200,"unikey":...}`。

## 9. 退出与重启恢复

- 全量 `player` 快照内保存 `_playbackState: { trackID, position }`，位置直接读取音频后端，
  不使用可能滞后一秒的 UI 进度。切歌加载途中保存实际音源对应的歌曲，并对齐列表下标。
- 每秒只更新很小的 `playerPlaybackState` 检查点，不重复序列化完整播放列表；恢复时先核对歌曲 ID，
  防止旧曲进度应用到新曲。新格式优先，旧的独立时间键仅用于迁移。
- 初始 offset 随恢复请求传入加载流程，不再使用异步完成后的无条件 `seek()`；
  新选曲的请求代际不会受旧恢复影响。恢复失败时保留原曲，播放按钮可按原位置重试。
- `beforeunload` 即使没有待保存变更也抓取实时位置。窗口、托盘、MPRIS 的退出统一使用
  `app.quit()`，主进程 `before-quit` 等待渲染进程保存并 `session.flushStorageData()`，
  然后才关闭窗口。渲染进程无响应时最多等 1.5 秒，避免退出挂住。
- `tests/playback-restore.electron.js` 使用独立临时用户目录，实际运行 4 个 Electron 进程，
  连续验证 Web Audio 的 0.625s / 0.375s 和 Howler 的 0.5s 恢复；同时测试恢复后的正常播放。
  歌曲详情/音源使用本地测试素材，浏览器存储、音频后端、退出保存和进程重启均为真实执行。

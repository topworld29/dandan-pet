# 蛋蛋桌宠 · 技术架构文档

> 对应版本：v0.2.2 ｜ 文档最后校对：2026-09-02（已逐节对照当前源码核实）

这份文档写给想**理解**或**改造**本项目的开发者：它说明蛋蛋桌宠由哪几层构成、各层怎么通信、
关键子系统如何工作、配置从哪来到哪去、以及怎么重新构建发布。

文中还完整收录了开发过程中踩过的 11 个坑（第 8 章）。那部分不是流水账 ——
它们记录的是「代码里某些看起来多余的写法为什么必须那样写」，改代码前建议先读一遍，
否则很容易把已经修好的东西再改回去。

所有路径均相对于项目根目录（下称 `<项目根>`）。

---

## 1. 一句话定位

**桌面轻量 AI 桌宠「蛋蛋」** —— 一只会聊天、能干活的小蛋蛋，以 Electron 透明浮窗的形式飘在桌面上。

技术上它是三层：Electron 外壳（UI + 系统集成）、Python 后端（大脑）、opencode（干活内核）。
三层跑在同一台机器上，外壳与后端之间只走本机 WebSocket，后端与 opencode 之间走子进程。

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────┐
│ ① 蛋蛋外壳（Electron，<项目根>/）                  │
│    · 透明置顶浮窗（透明蛋蛋飘在桌面上）              │
│    · 聊天窗（独立窗口，液态玻璃气泡）               │
│    · 翻译浮窗 / 图片识别窗 / 设置窗 / OCR 窗       │
│    · 截图区域选择器（全屏遮罩+画框裁剪）            │
│    · 主进程 main.js 持有 WebSocket + spawn 后端     │
│    · preload.js contextBridge 暴露安全 API          │
│    · renderer/ 前端（pet.css/chat.css/ocr.css…）    │
└───────────┬──────────────────────────────────────┘
            │ ws://127.0.0.1:8765/ws（本机）
            ▼
┌──────────────────────────────────────────────────┐
│ ② 后端大脑（Python，backend/）                     │
│    · server.py — FastAPI + WebSocket 入口          │
│    · chat_llm.py — 闲聊（当前服务，openai SDK）    │
│    · agent_runner.py — 干活（opencode + 同一模型）  │
│    · router.py — 意图路由（聊天 vs 干活）           │
│    · permission.py — 权限网关                      │
│    · memory.py — 长期记忆（SQLite）                │
│    · proactive.py — 主动触发（久坐提醒/文件监测）   │
│    · config.py — 配置加载（lru_cache）             │
│    · config.yaml — 所有配置（key/人设/模式…）       │
└───────────┬──────────────────────────────────────┘
            │ subprocess
            ▼
┌──────────────────────────────────────────────────┐
│ ③ 干活内核 opencode（随包附带，v1.17.13）           │
│    · 模型：跟随设置窗里选的模型                    │
│    · 配置：~/.config/opencode/opencode.json        │
│    · build 模式：可读写/跑命令（--auto）            │
│    · plan 模式：只读，只给分析/计划                 │
│    · 沙箱工作目录：设置窗指定的白名单目录            │
└──────────────────────────────────────────────────┘
```

几个值得先记住的设计点：

- **后端由外壳拉起**：`main.js` 启动时 `spawn` 后端进程；如果 8765 端口已被另一个后端占用，
  新进程会快速退出，外壳的 WebSocket 直接连上已在跑的那个。
- **后端目录是解析出来的**，不是写死的。`main.js` 的 `resolveBackendDir()` 按优先级依次尝试：
  环境变量 `DANDAN_BACKEND_DIR` → 打包后的 `resources/backend` → 开发时的 `<项目根>/backend`
  → 一个历史遗留的项目外兜底路径。四条候选里，第一个存在 `server.py` 或 `dandan-backend.exe`
  的即胜出。
- **开发态与打包态共用同一套代码**：后端在开发时是 `backend/venv/Scripts/python.exe server.py`，
  打包后是 PyInstaller 冻结的 `dandan-backend.exe`，`main.js` 只在 spawn 那一处分叉。

---

## 3. 已完成功能一览

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 0 | 透明浮窗骨架 | ✅ 完成 | 无边框/置顶/穿透/原生拖动/防丢失安全网/全屏隐藏 |
| 1 | 像素蛋蛋形象+动画 | ✅ 完成 | 眨眼/呼吸/走两步(手动)/张嘴说话 |
| 2 | 聊天 | ✅ 完成 | 当前选中的服务+模型驱动、液态玻璃气泡、思考/停止按钮 |
| 3 | Agent 干活 | ✅ 完成 | opencode + 当前选中的模型、两种模式（构建/计划）、执行进度/中断 |
| 4 | 语音 | ❌ 已移除 | 2026-08-31 彻底删除 TTS/ASR：删掉 `tts.py` / `stt.py`、喇叭与麦克风按钮、配置里的 `voice` 段（连同语音服务独用的那把 API key）。详见第 11 章 |
| 5 | 主动触发 | ✅ 完成 | 15 分钟久坐提醒（只出气泡）、沙箱新文件监测、可选整点报时 |
| 6 | 全局设置 | ✅ 完成 | 右键菜单→设置窗（服务下拉/API Key/模型下拉/工作目录/快捷键），key 自动同步进 `opencode.json` |
| 7 | 情绪系统 | ✅ 完成 | 7 种情绪随机轮播，各有表情+头顶图标+动画（表现层演出，非情感识别，见第 6 章） |
| 8 | 截图识别 | ✅ 完成 | 全屏截图→框选区域→当前模型识别→翻译→AI 提问，同一窗口集成 |
| 9 | 划词翻译 | ✅ 完成 | 默认 `Ctrl+Q`，当前服务翻译，独立浮窗，复制按钮，长/短文本不同关闭逻辑 |
| 10 | 全屏检测 | ✅ 完成 | PowerShell 脚本（WS_POPUP + 覆盖屏幕判定），异步不阻塞 |
| 11 | 鼠标卡顿修复 | ✅ 完成 | 全屏检测从 `execSync` 改 `execFile` 异步 |
| 12 | opencode 检测 | ✅ 完成 | 启动时检测，缺失则引导安装（复制 npm 命令） |
| 13 | 工作目录守卫 | ✅ 完成 | 没配目录时发任务 → 弹设置窗引导 |
| 14 | 模型服务可切换 | ✅ 完成 | 设置窗下拉切 DeepSeek / OpenAI，两家 key+model 各存各的；模型列表从官方 `GET /models` 拉取并过滤 |
| 15 | 上下文管理 | ✅ 完成 | 超长自动摘要压缩、手动清空、闲置很久时询问是否清空 |

---

## 4. 窗口与快捷键

### 4.1 窗口清单

外壳一共 6 个窗口，全部由 `main.js` 创建并加载 `renderer/` 下对应的三件套：

| 窗口 | 文件 | 特性 |
|------|------|------|
| 蛋蛋浮窗 | `renderer/index.html` + `pet.css` + `pet.js` | 透明/置顶/无边框/原生拖动/点击穿透 |
| 聊天窗 | `renderer/chat.html` + `chat.css` + `chat.js` | 关闭只隐藏、液态玻璃气泡、工具条 |
| 翻译浮窗 | `renderer/trans.html` + `trans.css` + `trans.js` | 跟鼠标弹出、短文本点窗外可关 |
| 设置窗 | `renderer/settings.html` + `settings.css` + `settings.js` | 屏幕居中、标题栏可拖 |
| OCR 图片识别 | `renderer/ocr.html` + `ocr.css` + `ocr.js` | 关闭只隐藏、左右分栏、标题可拖 |
| 截图选择器 | `renderer/crop.html` + `crop.css` + `crop.js` | 全屏遮罩、画框裁剪、Esc 取消 |

每个窗口的样式彼此独立，项目内**没有**跨窗口共享的主题 / 换肤系统 ——
改某个窗的观感不会影响其它窗，也没有全局主题变量可依赖。

渲染层不直接碰 Node API：`preload.js` 用 `contextBridge` 暴露一组窄接口
（`sendText` / `sendRaw` / 窗口控制等），渲染层通过 `window.petAPI.*` 调用，
主进程再把它转成 IPC 处理或 WebSocket 消息。

### 4.2 全局快捷键

| 快捷键 | 功能 | 可改？ |
|---|---|---|
| `Alt+Space` | 开/关聊天窗 | ❌ 固定，在 `main.js` 里单独注册 |
| `Ctrl+Q` | 划词翻译 | ✅ 设置窗可改 |
| `Ctrl+Alt+Q` | 截图识图 / OCR | ✅ 设置窗可改 |

后两个的当前值存在 `%APPDATA%\dandan-pet\shortcuts.json`（外壳自己的配置，不进 config.yaml），
默认值写在 `main.js` 的 `DEFAULT_SHORTCUTS`。

一个容易忽略的细节：设置窗**录制**快捷键时，必须先临时注销全部全局热键
（`shortcuts-pause` / `shortcuts-resume` 两个 IPC），
否则按下的组合会被已注册的全局热键抢走，根本传不到输入框里。

`Alt+Space` 有可能被别的程序占用而注册失败 —— 那种情况下托盘菜单和双击蛋蛋仍能打开聊天窗，
控制台会打印一行注册失败提示。

---

## 5. WebSocket 协议速查

外壳主进程与后端之间的唯一通道是 `ws://127.0.0.1:8765/ws`。后端侧的读写都在
`backend/server.py` 的 `websocket_endpoint()` 里：一个 `reader` 协程独占读 socket，
控制类消息就地分发，用户消息塞进队列交给 `worker` 处理。

### 5.1 前端 → 后端

| type | 用途 |
|------|------|
| `{"text":"..."}` | 用户消息（也接受非 JSON 的纯文本） |
| `{"type":"confirm_result","id":"...","ok":true/false}` | 风险任务确认结果 |
| `{"type":"interrupt"}` | 中断当前任务 / 丢弃正在等待的回复 |
| `{"type":"set_mode","mode":"build"/"plan","silent":bool}` | 切换干活模式；`silent` 为真时不回聊天气泡 |
| `{"type":"clear_context","silent":bool}` | 清空聊天上下文 |
| `{"type":"reload_config"}` | 设置窗保存后通知后端清 `lru_cache`，热更新配置 |

> 带 `type` 但不在上表中的消息会被后端识别为「未知控制消息」并忽略，
> 不会被当成用户输入喂给大模型。加新消息类型时记得在 `reader` 里补一个分支，
> 否则它会静默消失，且不报错。

### 5.2 后端 → 前端

| type | 用途 |
|------|------|
| `{"type":"reply","text":"..."}` | AI 回复（主动触发的提醒也走这个） |
| `{"type":"confirm","id":"...","text":"..."}` | 请求确认风险任务 |
| `{"type":"exec_start"}` | 任务开始执行（前端显示执行面板） |
| `{"type":"exec_progress","text":"..."}` | 执行过程的一行进度 |
| `{"type":"mode","mode":"..."}` | 连接时同步模式 / 切换后回显 |
| `{"type":"need_workdir","text":"..."}` | 没配工作目录，引导去设置窗 |
| `{"type":"context_compacted","text":"..."}` | 上下文超长，已自动摘要压缩 |
| `{"type":"context_cleared"}` | 上下文已清空 |

### 5.3 两个看着像协议、其实不走 WebSocket 的消息

- `clear_prompt`（主进程 → 聊天窗）：闲置很久时由 `main.js` 的闲置检测发出，
  询问用户是否清空对话。后端不参与。
- `clear_decline`（聊天窗 → 主进程）：用户对上面那个询问选了「否」。
  `main.js` 的 `send-raw` 处理器把它**拦在本地**，只重置闲置计时，不转发给后端。

改协议时留意这两条：它们和真正的 WS 消息走同一个 `sendRaw` 出口，长得一模一样。

---

## 6. 情绪系统

7 种情绪随机出现：一段情绪持续 4~9 秒，然后回归平静 8~20 秒，再随机来一个。
实现集中在 `renderer/pet.js` 的 `MOODS` 数组 + `scheduleMood()`，
以及 `renderer/pet.css` 里每种情绪对应的一个 `.mood-<名字>` class。

> ⚠ **这是纯表现层的演出，不是情感分析。** 情绪由定时器随机挑选，
> 既不读对话内容，也不做任何情绪识别，后端完全不参与。
> 别让「情绪系统」这个名字误导你去找一条并不存在的推理链路。

| 情绪 | 眼睛 | 嘴巴 | 图标 | 其它 |
|------|------|------|------|------|
| 生气 angry | 斜压上扬 | 倒扣（红） | 💢 左上角 | 微微发抖 + 壳边发红 |
| 高兴 happy | 弯月（无瞳） | 大笑 | 🎵→耳机 + 飘音符 | 上下蹦跳 |
| 可怜 pitiful | 水汪汪放大 | 小抿 | 含泪不落 | 微微发抖 + 泪光闪烁 |
| 累 tired | ∩ 型闭眼线（完全闭上） | 平嘴 | 💤 左上角 | 呼吸变慢 |
| 伤心 sad | 眼角下垂 | 倒扣（小） | 流泪（真滴落） | 腮红消失 + 身子微垂 |
| 兴奋 excited | 星星眼（金色） | 圆张大嘴 | 无（星星眼够了） | 猛烈蹦跳 |
| 卖萌 cute | 大高光 | 小笑嘴 | 💕 左上角 | 歪头 + 腮红加深 |

**演示模式**：`renderer/pet.js` 里的 `DEMO_MODE`，默认 `false`；
改成 `true` 会每 3 秒轮播一种情绪，方便一次性把 7 张脸都看一遍。

---

## 7. 配置系统

### 7.1 config.yaml 是唯一真源

Electron 侧和 Python 侧读写的是**同一个文件**：`main.js` 的 `CONFIG_YAML` 和
`config.py` 的 `CONFIG_PATH` 都指向后端目录下的 `config.yaml`。

仓库里带的是 `backend/config.example.yaml`（key 全空的模板）。
首次使用时复制成 `config.yaml`，或直接打开设置窗填写 —— 设置窗保存时会把值写进去。结构如下：

```yaml
chat:
  # 当前用哪个大模型服务 —— 设置窗那个下拉写的就是这一行
  provider: deepseek        # 可选 deepseek / openai

  # 两家的 key 和 model 各存各的，来回切不用重填
  providers:
    deepseek:
      base_url: https://api.deepseek.com
      model: "deepseek-v4-flash-vision-exp"
      api_key: ""
      max_tokens_param: max_tokens      # 参数方言，见坑 11
      supports_temperature: true
    openai:                 # 注意：中国大陆直连不通，需要代理
      base_url: https://api.openai.com/v1
      model: ""
      api_key: ""
      max_tokens_param: max_completion_tokens
      supports_temperature: false

  max_history: 10           # 最多带几轮历史对话给模型（一轮 = 一问一答）

agent:
  enabled: true
  whitelist_dir: ""         # 干活沙箱：用户在设置窗指定的白名单工作目录
  timeout_seconds: 180      # 单个任务最长等待秒数
  mode: plan                # build=可读写/跑命令 ｜ plan=只读，只给分析

proactive:
  enabled: true
  idle_reminder_seconds: 900   # 15 分钟没理它才主动打招呼
  hourly_chime: false          # 整点报时（默认关，避免吵）
  watch_sandbox: true          # 沙箱里出现新文件就提醒

persona:
  pet_name: 蛋蛋
  user_title: 主人
  system_prompt: |             # {pet_name} / {user_title} 会被上面两个值自动替换
    ...
```

`agent.whitelist_dir` 留空时，任何干活请求都会被拒绝，后端回一条 `need_workdir`
让前端弹设置窗引导 —— 这是防止 agent 在任意目录乱动文件的第一道闸。

### 7.2 配置加载与热更新

`config.py` 的 `load_config()` 带 `@lru_cache(maxsize=1)`，进程内只读一次文件。
设置窗保存后，`main.js` 通过 WebSocket 发 `{"type":"reload_config"}`，
后端调 `config.py:reload_config()` 清缓存，下一次取配置就是新值 —— 不需要重启后端。

`BASE_DIR` 的取法兼顾了两种运行形态：PyInstaller 冻结后 `__file__` 指向解包临时目录，
所以 `sys.frozen` 为真时改用 `os.path.dirname(sys.executable)`，
让 `config.yaml` 和 `memory.db` 始终落在 exe 旁边。

### 7.3 四条链路都跟着设置窗走

| 链路 | 位置 | 怎么取配置 |
|---|---|---|
| 聊天 | `backend/chat_llm.py` | `config.py` 的 `get_chat_provider()` |
| 划词翻译（流式 + 非流式） | `main.js` 的 `translateText` / `aiRefineStream` | `requireProvider()` |
| 截图识图 | `main.js` 的 `callVision` | `requireProvider()` |
| 干活 | `backend/agent_runner.py` 的 `opencode_model()` | 拼成 `"<服务名>/<模型名>"` |

识图和干活**共用同一个模型**（设置窗只有一个模型下拉）。选到不支持图片输入的模型时，
截图识别会报错。服务名 `deepseek` / `openai` 与 opencode 内置的 provider id 同名，
所以干活的模型串可以直接拼，不需要映射表。

### 7.4 模型下拉的列表哪来的

`main.js` 的 `listModelsFromProvider()` 调各家官方的 `GET {base_url}/models`
（Bearer 鉴权，15 秒超时），拿到后过两道筛：

1. **`NON_CHAT_MODEL` 正则** —— 滤掉压根不能对话的条目
   （embedding / 语音 / 图像 / 审核 / 重排 / realtime / 上古模型等）。
2. **`MODEL_MIN_VERSION`** —— 按版本下限只留新系列。目前只对 `openai` 生效
   （只留 gpt-5.6 及更新的，因为老版本条目太多，全列出来没法看）；
   没列进这张表的服务不做版本过滤。

设置窗用 `<input list=datalist>`，**既能下拉选也能手打**；
拉取失败时保留 config 里已存的值不动，只在提示行说明原因。

### 7.5 opencode 配置是自动生成的

设置窗每次保存都会调 `main.js` 的 `syncOpencodeConfig()`，**自动生成/更新**
`~/.config/opencode/opencode.json`：把当前服务写成一个 `provider.<服务名>` 条目
（`npm: @ai-sdk/openai-compatible` + apiKey + baseURL + 当前模型）。
使用者不需要手动配 opencode。

### 7.6 运行时数据放哪

| 位置 | 装的什么 |
|---|---|
| `backend/config.yaml` | 全部配置（key / 人设 / 模式…），Electron 与 Python 共读共写 |
| `backend/memory.db` | 长期记忆（SQLite） |
| `%APPDATA%\dandan-pet\` | `shortcuts.json` 快捷键、`ui-state.json` 模式、`dandan.log` 日志、Electron 缓存 |
| `~\.config\opencode\opencode.json` | 干活的 provider 配置（设置窗自动写） |
| 白名单工作目录 | 干活沙箱，由 `agent.whitelist_dir` 指定 |

注意前两项写在**后端目录**里，这直接决定了安装位置的选择 —— 见坑 10。

---

## 8. 关键踩坑经验（11 条）

这一章是全文最值钱的部分。每条都是「现象 → 根因 → 解法」，且解法都还留在当前代码里。

### 🕹 坑 1：175% 缩放下拖动偏移

- **现象**：用 JS 算坐标移动窗口，往上拖时蛋蛋反而往下跑
- **根因**：JS 坐标计算有 1 帧延迟，高分屏缩放下这个延迟被放大成反向偏移
- **解法**：放弃 JS 拖动，改用 **CSS `-webkit-app-region: drag` 原生拖动**（零延迟，像素级跟手）

### 🕹 坑 2：穿透切换链路断掉

- **现象**：弹过一次右键菜单后，点击永久失灵
- **根因**：弹菜单会重置窗口状态，导致渲染层记录的穿透状态和主进程不同步
- **解法**：**主进程每 80ms 轮询** `getCursorScreenPoint()` 与蛋蛋矩形（`PET_RECT` 常量）比对，
  直接调 `setIgnoreMouseEvents()`；菜单关闭时翻转 `interactiveNow`，
  打破「状态没变就不重发」的短路，强制重新应用一次

### 🕹 坑 3：`setPosition` 在 175% 缩放下反复调用会把位置带偏

- **现象**：往右走每帧 +2，结果反而在倒退
- **解法**：程序化移动窗口一律用 **`setBounds({x, y, width, height})`，显式带上宽高**

### 🕹 坑 4：TTS 同步播放不响应中断（历史记录，语音已于 2026-08-31 移除）

- **现象**：按静音按钮后，还是把整段念完
- **根因**：`winsound.SND_MEMORY` 同步播放跑在后台线程，从主线程调 `SND_PURGE` 打断不了
- **解法**：改成 **`SND_ASYNC`**（异步播放）+ **停止代际标记**
  （`_stop_gen`：合成完成时若代际号已变，就直接放弃播放）
- **留下的通用教训**：任何「后台线程做长任务、主线程发停止信号」的结构，
  光靠底层 API 的中断标志往往不够，需要一个由发起方递增、由执行方回查的**代际号**兜底

### 🕹 坑 5：`execSync` 调 PowerShell 阻塞导致鼠标卡顿

- **现象**：每约 5 秒鼠标顿一下
- **根因**：全屏检测每 2 秒同步调一次 PowerShell（`execSync`），阻塞 Electron 主进程
- **解法**：改成 `execFile`（异步回调），全屏检测在后台跑，主进程不阻塞

### 🕹 坑 6：`[hidden]` 属性被 CSS `display:flex` 覆盖

- **现象**：OCR 遮罩、下拉列表等元素一直显示，设了 `hidden` 也没用
- **根因**：`[hidden]` 的浏览器默认样式是 `display:none`，但优先级极低，
  任何显式的 `display:flex` 都会盖掉它
- **解法**：显式补一条 `.xxx[hidden] { display: none !important; }`
  （当前 `pet.css` 与 `settings.css` 里各有若干处）

### 🕹 坑 7：config.yaml 双引号里的反斜杠被当转义符

- **现象**：Windows 路径写进 YAML 的双引号字符串后，后端 YAML 解析崩溃
- **解法**：保存路径时把 `\` 统一转成 `/`（Python 两种分隔符都认）

### 🕹 坑 8：曾用「数第几个 api_key」的正则读写 config.yaml

- **现象**：往 config.yaml 增删任何一行 `api_key:`，几把 key 会整体串位，而且是**静默出错**
- **根因**：Electron 侧当时没有 YAML 库，早期用 `yaml.match(/api_key:.../g)` 按出现顺序取下标
- **解法**：把 `js-yaml` 提为**正式 dependency**
  （原先只是 electron-builder 的传递依赖，打包后进不去），**读**用真正的 YAML 解析；
  **写**仍走定向行替换 —— `setProviderFieldInConfig()` 先定位 `providers.<名字>:` 块，
  再只改块内那一行。
  **绝不能用 `yaml.dump()` 整份重写**，那会把 config.yaml 里写给使用者看的中文注释全部冲掉

### 🕹 坑 9：flex 列布局里，带 overflow 的子元素会被压成一条线

- **现象**：设置窗的模型下拉列表只显示成一条约 10px 高的细条，看得见高亮色但选不了
- **根因**：`.settings__body` 是 `display:flex; flex-direction:column`，子项默认 `flex-shrink:1`；
  而列表设了 `overflow-y:auto`，这会让它的 `min-height:auto` 解析成 **0**，
  于是容器一放不下就把它压到零高。`max-height` 只限上限，**防不住收缩**
- **解法**：给列表加 `flex: none`，并在 `.settings__body > * { flex: none; }` 兜底，
  让内容超高时由 body 出滚动条，而不是压扁某一项

### 🕹 坑 10：安装位置决定了「能不能保存设置」

- **背景**：`config.yaml` 和 `memory.db` 都写在**后端目录**里（`config.py` 的 `BASE_DIR`）。
  打包版那就是安装目录下的 `resources\backend\`
- **现在没事**：`package.json` 的 nsis 配置是 `perMachine: false`，
  装到使用者自己的 `%LOCALAPPDATA%\Programs\` 下，可写、免管理员
- **⚠ 改成 `perMachine: true` 就会炸**：装进 `Program Files` 后没有写权限，
  设置窗保存 key、长期记忆写库会全部失败。而且**是静默失败** ——
  `setProviderFieldInConfig()` / `setWorkDirInConfig()` 都是 `try/catch` 吞掉异常只返回 false，
  界面还会照常显示「✓ 已保存」，人根本看不出来
- **真要装 Program Files**：得先把这两个可写文件挪到 `app.getPath("userData")` 下

### 🕹 坑 11：各家对 `max_tokens` / `temperature` 的要求不一样（参数方言）

- **现象**：切到 OpenAI 后识图直接
  `HTTP 400: Unsupported parameter: 'max_tokens' is not supported with this model.
  Use 'max_completion_tokens' instead.`
- **2026-08-22 实测对比**：

  | 参数 | OpenAI 新一代（gpt-5.x / o 系列） | DeepSeek |
  |---|---|---|
  | `max_tokens` | ❌ 400 | ✅ |
  | `max_completion_tokens` | ✅ | — |
  | `temperature: 0` 或 `0.7` | ❌ 400「Only the default (1) is supported」 | ✅ |
  | 不传 temperature | ✅ | ✅ |

- **影响面比想象大**：不只识图 —— 划词翻译（0.7）、聊天（0.8）、上下文压缩（0）、
  记忆抽取（0）全都会 400，一共 6 个调用点
- **解法**：把差异写进 config.yaml 的 provider 块，JS 和 Python 读同一份，各自只在一处消化：

  ```yaml
      max_tokens_param: max_completion_tokens   # 长度上限用哪个参数名
      supports_temperature: false               # 能不能传 temperature
  ```

  - JS 侧：`main.js` 的 `buildBody(p, { messages, stream, maxTokens, temperature })`
  - Python 侧：`config.py` 的 `provider_kwargs(provider, temperature=, max_tokens=)`
  - 缺省值按 DeepSeek 那一套（`max_tokens` + 允许 temperature），
    所以以后接别的 OpenAI 兼容服务多半不用动配置；碰到 400 再按上表加两行
- **教训**：「OpenAI 兼容」只保证端点形状和消息结构一样，**参数细节各家会分叉**。
  接新服务商时别只测能不能连通，要把实际用到的参数组合都打一遍

---

## 9. 重新打包发布（⚠ 必须两层都打）

改完代码要出新安装包时，**只重打 Electron 那层是不够的** —— 后端是 PyInstaller 单独打的 exe，
改了 `backend/*.py` 却不重建它，装到别人机器上跑的还是旧后端。顺序：

```bash
# 1. 改版本号：package.json 的 "version"

# 2. 重建后端 exe（改过 backend/*.py 就必须做）
cd backend
./venv/Scripts/python.exe -m PyInstaller dandan-backend.spec --noconfirm \
    --distpath dist --workpath build_pyi

# 3. 把新构建装进 <项目根>/dist-backend/
#    ⚠ config.yaml 不在 PyInstaller 产物里，要先备份再放回，
#      否则模板丢失（进发布包的那份必须保持 api_key 全空）

# 4. 打 Electron 整包（在 <项目根> 下）
npm run dist        # → release/蛋蛋桌宠 Setup <版本>.exe
```

打完**一定要验一下新包里装的是不是新代码**（别信文件时间戳，asar 会骗人）：

```bash
A=release/win-unpacked/resources/app.asar
grep -c "某个你刚加的函数名" "$A"     # 应 > 0
grep -c "某个你刚删的函数名" "$A"     # 应 = 0
stat -c "%y" release/win-unpacked/resources/backend/dandan-backend.exe   # 应是今天
grep -n api_key release/win-unpacked/resources/backend/config.yaml       # 必须全空
```

### electron-builder 配置要点

`package.json` 的 `build` 段目前是：

- **`files`** 只列了 `main.js` / `preload.js` / `check-fullscreen.ps1` / `renderer/**`，
  但 electron-builder 会**自动带上 `dependencies`**（不含 `devDependencies`）。
  `js-yaml` 就是因为原先只是传递依赖，必须显式 `npm i js-yaml --save` 才进得了包 ——
  新加 npm 依赖时留意这一点。
- **`asarUnpack`** 里放了 `check-fullscreen.ps1`：PowerShell 脚本必须以真实文件形式存在才能被调用，
  打进 asar 里就读不到了。对应地，`main.js` 取脚本路径时会把 `app.asar` 替换成 `app.asar.unpacked`。
- **`extraResources`** 把 `dist-backend/` → `resources/backend`、`dist-opencode/` → `resources/opencode`。
- **`nsis`** 是 `oneClick: true` + `perMachine: false`（后者的重要性见坑 10）。

### 目标机器需要预装什么？—— 什么都不用

| 组件 | 怎么解决的 |
|---|---|
| Python | 不需要。后端是 PyInstaller 冻结的 `dandan-backend.exe`，自带解释器 |
| Node.js | 不需要。Electron 自带运行时 |
| opencode | **不需要**。官方独立版 `opencode.exe` 打进了 `resources/opencode/`；`main.js` 的 `envForBackend()` 会把该目录**插到 PATH 最前**再 spawn 后端，于是 `agent_runner.py` 里的 `shutil.which("opencode")` 先找到内置那个 |

三个附带说明：

- `envForBackend()` 特意处理了 Windows 上 PATH 键名可能写作 `Path` 的情况 ——
  直接加一个 `PATH` 键会出现大小写重复键，行为不确定。所以它先大小写不敏感地找到已有键名，再往上拼。
- 它还默认设了 `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`：opencode
  **首次干活要现场从 npm 下载模型适配包**，走官方源在国内会无输出卡死
  （表现为「任务超时，已停止」，2026-07-06 实测）。所以**第一次用干活功能需要联网**；
  聊天 / 翻译 / 识图不依赖 opencode。使用者自己设过这个变量则尊重其值。
- 万一 opencode 真的找不到，降级是优雅的：只有干活会报「找不到 opencode 命令行」，其它功能照常。

**分发**：只发 `release\蛋蛋桌宠 Setup <版本>.exe` 这一个文件，自包含（含后端 + opencode）。
发布包里的 `config.yaml` 是 key 全空的模板。
⚠ **不要分发开发目录下的 `backend/config.yaml`** —— 那是本机在用的那份，里面是明文真 key。
⚠ 若目标使用者在中国大陆，OpenAI 那个选项连不上，应引导其选 DeepSeek。

---

## 10. 启动 / 停止 / 排查

### 启动

```bash
npm start
```

或双击项目根目录下的 `启动蛋蛋.bat`（直接拉起 `node_modules` 里的 electron.exe，
绕开 npm 包装层的控制台黑框）。

外壳会自动 spawn 后端：开发态是 `backend/venv/Scripts/python.exe server.py`，
打包态是 `resources/backend/dandan-backend.exe`。

### 停止

```powershell
Get-Process electron -EA SilentlyContinue | Stop-Process -Force
Get-Process python   -EA SilentlyContinue | Stop-Process -Force
```

### 检查状态

```powershell
(Get-Process electron -EA SilentlyContinue).Count   # 正常应为 6-8
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -Method Get
```

### 日志

`npm start` 的控制台输出即含后端日志（`[backend]`、`[ws]`、`[fullscreen]`、`[shortcuts]` 等前缀）。
打包版的日志写在 `%APPDATA%\dandan-pet\dandan.log`，每次启动若超过 1MB 会先清空。

后端自身有一层重启保护：8 秒内就退出算「快速失败」（多半是端口占用或启动即崩），
连续 5 次快速失败就停手，不再无限重启 —— 排查启动问题时先看这条。

---

## 11. 语音功能移除记录（2026-08-31）

早期版本里蛋蛋会把回复念出来（TTS），也能按麦克风说话转文字（ASR）。
出于密钥安全考虑，整套语音功能已被彻底移除，语音服务独用的那把 API key 也一并从项目中清除。
移除后项目里的 key 从 3 把降到 2 把。

### 删了什么

| 层 | 改动 |
|---|---|
| 后端文件 | 删除 `backend/tts.py`、`backend/stt.py` |
| `server.py` | 删掉 tts / stt / get_voice 的 import；`_runtime` 去掉 `muted`；`_send_reply` 去掉朗读；`interrupt` 去掉 `tts.stop()`；删掉 `stt_start` / `stt_stop` / `mute` / `set_mute` 四个消息处理；删掉 `_watch_silence()` / `_finish_stt()` |
| `config.py` | 删掉 `get_voice()` |
| 各份 `config.yaml` | 删掉整个 `voice:` 段（在用配置、example 模板、dist-backend 模板三处） |
| `chat.html` | 删掉 🔊 静音按钮、🎤 麦克风按钮（含内嵌 SVG） |
| `chat.js` | 删掉 `muteBtn` 变量、麦克风逻辑、静音开关逻辑、`stt_text` / `stt_auto_stop` 两个分支 |
| `chat.css` | 删掉 `.tools__mute`、`.chat__mic`、`@keyframes mic-pulse`；输入框 padding 由 `6px 34px 6px 10px` 收回 `6px 10px`（原先右侧是给麦克风留的位置） |

### ⚠ 看着像残留、但必须保留的东西

- **`main.js` 的 `NON_CHAT_MODEL` 正则里含 `tts` / `audio` / `speech` / `voice` 等词。**
  这是**模型下拉的过滤器**（见 7.4），作用是把语音类模型**排除**出聊天模型列表，
  和语音功能本身无关，**必须保留** —— 删掉它，模型下拉里就会混进一堆没法对话的条目。
- `requirements.txt` 无需为此改动：语音相关的三方库原本就是在函数内惰性 import 的，
  从未写进依赖清单。
- `dandan-backend.spec` 无需改动：`hiddenimports` 是空的，不含语音模块。

### 验证方式

```bash
grep -rn -iE "tts|stt_|micBtn|muteBtn|chat__mic|tools__mute|get_voice|recorder|winsound|sounddevice" \
  backend/*.py renderer/ main.js preload.js
```

应**只命中 `main.js` 的 `NON_CHAT_MODEL` 那一行**。另外：各份 config.yaml 用 `yaml.safe_load`
解析后顶层键应为 `['chat','agent','proactive','persona']`（无 `voice`）；渲染 chat.html 后
`getElementById("muteBtn")` 与 `getElementById("micBtn")` 均应为 `null`。

（2026-09-01 复核：上述验证全部通过。）

---

## 12. 待做事项

| 事项 | 说明 |
|---|---|
| **key 明文存储** | `config.yaml` 里的 key 是明文。若该目录处于云盘同步范围内，风险会被放大。可考虑改用系统凭据库，或至少做加密存储 |
| **OpenAI 大陆不通** | `api.openai.com` 在中国大陆直连不通，需要代理。项目当初选 DeepSeek 就是因为「大陆可直接用」。切到 openai 后拉不到模型列表，基本就说明网络到不了 |
| **确认弹窗粒度** | 目前 build 模式不逐步确认、直接执行，plan 模式只读。若想恢复「每步确认」逻辑，需要改 `permission.py` 的 `needs_confirm()` |
| **后端目录兜底路径过时** | `resolveBackendDir()` 的第 4 条候选指向一个项目外的历史布局目录，现已无用，可以删掉以减少困惑 |

已完成、不再是待办的历史项：打包成应用（v0.2.1 NSIS 单文件安装包）、
`lru_cache` 配置热更新（`reload_config` 消息链路）、
硬编码路径清理（配置路径已由 `BASE_DIR` 推导，工作目录改为设置窗指定）、
`requirements.txt` 不完整（v0.2.2 已补齐 `APScheduler` / `watchdog` / `websockets` 并锁定版本，
照清单装完即可启动）。

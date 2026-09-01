# 蛋蛋桌宠 · dandan-pet

一只常驻在 Windows 桌面右下角的 AI 桌宠：能陪你聊天，能划词翻译、截图识图，也能在你指定的工作目录里读写文件、跑命令帮你干活。

**dandan-pet** is a Windows desktop AI pet: a transparent always-on-top Electron overlay backed by a local Python (FastAPI) service and an `opencode` agent core — it chats, translates selected text, reads text from screenshots, and does real file/command work inside a directory you choose.

版本 **v0.2.2** · 平台 **Windows 10/11 x64** · 许可 **MIT**

---

## 界面

<!-- 截图待补：桌面浮窗 / 聊天窗 / 设置窗 / 截图识图 -->

截图待补充，占位注释已留在上方，补图时直接替换即可。

---

## 功能

| 分类 | 说明 |
| --- | --- |
| 透明置顶浮窗 | 无边框、透明、置顶（`screen-saver` 层级），不占任务栏。光标不在蛋蛋身上时整窗**鼠标穿透**，完全不挡后面的操作；左键按住即可拖动（主进程按鼠标事件实时移动窗口，不用系统原生拖动，避免透明窗口拖完不重绘）；每 10 秒兜底校正一次位置，**至少 44px 留在屏幕内**，不会被拖丢；检测到前台有全屏应用时**自动隐藏**，退出全屏自动恢复（也可从托盘手动覆盖） |
| 形象与动画 | 角色完全用 CSS 画出来（蛋身 + 大眼睛 + 蝴蝶结 + 腮红）：待机呼吸、随机间隔眨眼（偶尔连眨两下）、右键「遛一遛」走两步（左右摇摆 + 窗口平移，每一步都按屏幕边界钳制）、收到回复时张嘴「说话」几秒 |
| 情绪表情 | 7 种情绪：`angry` / `happy` / `pitiful` / `tired` / `sad` / `excited` / `cute`，各自有独立的眼、嘴、头顶图标与动画（高兴时会戴上耳机飘音符，可怜时会掉眼泪）。情绪是随机出现的表情演出——持续 4~9 秒后回归平静，不需要你去「解决」它 |
| 聊天 | 双击蛋蛋或 `Alt+Space` 打开聊天窗。液态玻璃质感气泡（`backdrop-filter` 毛玻璃，用户淡蓝 / 蛋蛋淡粉）、「蛋蛋想想…」思考占位气泡、⛔ 随时中断当前回复或任务、🧹 一键清空对话。聊天窗关着时，回复会在蛋蛋头顶冒气泡显示 10 秒 |
| Agent 干活 | 「干活」类请求由后端交给 **opencode** 子进程执行，两种模式对应 opencode 的两个内置 agent：**build 构建模式**（可读写文件、跑命令，`--auto` 自动批准）与 **plan 计划模式**（只读，只给分析和计划，默认）。执行过程逐行推送进度（🔧 读文件 / 改文件 / 跑命令 / 查找文件…），可随时中断（连子进程树一起结束），模式选择会记住到下次启动 |
| 意图路由 | 每句话先用关键词规则预筛，模糊的再让模型做一次轻量分类，决定走「闲聊」还是「干活」，避免闲聊也去启动 agent |
| 长期记忆 | 每轮闲聊后台异步抽取「关于主人的事实」，写入本地 SQLite（`backend/memory.db`），下次对话拼进 system 提示词；对话估算超 100k token 时自动把旧对话摘要压缩，并在聊天窗提示一句 |
| 主动触发 | 久坐 / 长时间没互动会主动打招呼（默认 900 秒）；监测工作目录里出现新文件就提醒一句；可选整点报时（默认关闭）。闲置 60 分钟后蛋蛋会问一句「要不要清空这次对话」，选了才清 |
| 截图区域识图 | 快捷键（默认 `Ctrl+Alt+Q`）抓全屏（按物理像素抓，高 DPI 屏不发虚）→ 拖框选区 → 交给当前模型识别图中文字。结果窗可复制原文、就地翻译、对着这张图继续追问 |
| 划词翻译 | 快捷键（默认 `Ctrl+Q`）取走当前选中的文本，自动判断中英方向并互译，流式打字机效果显示在光标附近的浮窗里；短文本（<100 字符）点窗外即关，长文本需 ✕ 或 Esc 关闭 |
| 设置窗 | 选服务、填 API Key（密码框，可一键清空）、选模型（列表从各家官方 `GET /models` 拉取，自动滤掉不能对话的条目）、选工作目录、自定义两个快捷键（点输入框直接按组合键录制，冲突会提示并回滚） |
| 多服务热切换 | 内置 **DeepSeek** 与 **OpenAI** 两家，**Key 和模型各存各的**，来回切不用重填。保存后写回 `config.yaml` 并通知后端热重载（不必重启），同时把当前服务同步一份到 `~/.config/opencode/opencode.json`，让干活内核也直接可用 |
| 系统托盘 | 托盘图标（代码绘制，不依赖图片资源）：显示 / 隐藏蛋蛋、打开聊天、设置、退出；双击图标切换显示 |

> 快捷键默认值：`Alt+Space` 聊天（固定）、`Ctrl+Q` 划词翻译、`Ctrl+Alt+Q` 截图识图（后两个可在设置窗改）。

---

## 架构

三层，各司其职：

```
┌───────────────────────────────────────────────────────────────┐
│ ① Electron 外壳    main.js / preload.js / renderer/           │
│    浮窗 · 聊天窗 · 设置窗 · 识图窗 · 翻译浮窗 · 截图遮罩 · 托盘 │
│    穿透命中检测 / 全屏检测 / 全局快捷键 / config.yaml 读写      │
│    划词翻译 与 截图识图 直接调模型的 /chat/completions          │
└──────────────────────────┬────────────────────────────────────┘
                           │ WebSocket  ws://127.0.0.1:8765/ws
                           │ JSON 消息：text / interrupt / set_mode /
                           │ clear_context / reload_config ⇄ reply /
                           │ exec_start / exec_progress / mode …
┌──────────────────────────▼────────────────────────────────────┐
│ ② Python 后端      backend/（FastAPI + uvicorn，仅监听本机）   │
│    router 意图路由 → chat_llm 闲聊（人设 + 历史 + 记忆）        │
│                    → agent_runner 干活（拼 opencode 命令）      │
│    memory 长期记忆(SQLite) · proactive 主动触发(定时 + 文件监测)│
└──────────────────────────┬────────────────────────────────────┘
                           │ subprocess：opencode run --format json
                           │ 逐行流式事件 → 进度推送 / 可中断
┌──────────────────────────▼────────────────────────────────────┐
│ ③ opencode 干活内核                                            │
│    在 agent.whitelist_dir（工作目录）内读写文件、跑命令          │
└───────────────────────────────────────────────────────────────┘
```

要点：

- ① 和 ② 读的是**同一份** `backend/config.yaml`；设置窗保存后会发 `reload_config`，后端清缓存热更新。
- ② 由 ① 自动拉起并守护（异常退出会退避重启；连续 5 次快速失败就停手，避免端口被占时无限重启）。
- 后端只监听 `127.0.0.1:8765`，不对外暴露；`GET /health` 可用来确认它活着。

详细架构见 `docs/ARCHITECTURE.md`。

---

## 安装（推荐）

到 [Releases](../../releases) 下载最新的 `dandan-pet_<版本>_Windows_x64.exe`，双击安装即可。
NSIS 一键安装，装在当前用户目录下，不需要管理员权限；**后端与干活内核都已打包在内，使用者无需安装 Python 或 Node.js**。

安装前建议核对文件完整性，与 Release 页面公布的 SHA-256 比对：

```powershell
Get-FileHash '.\dandan-pet_0.2.2_Windows_x64.exe' -Algorithm SHA256
```

> 安装包**未做代码签名**，首次运行可能触发 Windows SmartScreen「未知发布者」提示。这是未签名的正常现象，不代表文件损坏——核对过 SHA-256 后选「更多信息」→「仍要运行」即可。请只从本仓库的 Release 页面下载。

装完后右键蛋蛋 →「设置」，选服务商、填入**你自己的 API Key**、选一个工作目录即可开始用。安装包内的配置文件不含任何密钥。

想改代码或自己构建，见下一节。

---

## 从源码运行

### 1. 前置

| 依赖 | 说明 |
| --- | --- |
| Windows 10/11 x64 | 全屏检测、截图、划词都依赖 Windows API，暂不支持其它系统 |
| Node.js 18+ | 装依赖、跑 Electron（`npm install` / `npm start`） |
| Python 3.10+ | 后端；代码用了 `str \| None`、`dict[str, ...]` 等 3.10+ 语法 |
| 一个大模型 API Key | DeepSeek 或 OpenAI 任选其一，聊天 / 翻译 / 识图 / 干活都用它 |

### 2. 装外壳依赖

```bash
npm install
```

### 3. 装后端依赖

在项目根目录下：

```powershell
cd backend
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

> 建好 `backend/venv` 后，Electron 启动时会优先用它；没有 venv 则回退到 PATH 里的 `python`。

### 4. 准备配置文件

```powershell
copy backend\config.example.yaml backend\config.yaml
```

然后编辑 `backend/config.yaml`，把你自己的 `api_key` 填进对应服务的那一行（也可以先留空，启动后在设置窗里填，效果一样）。
`config.yaml` 已被 `.gitignore` 排除，不会被提交。

### 5. 下载 opencode（干活内核，需自行准备）

1. 到 <https://github.com/sst/opencode> 的 **Releases** 页面，下载 **Windows x64** 版本；
2. 解压出 `opencode.exe`，放到项目根目录下的 `dist-opencode/`，即 `dist-opencode/opencode.exe`。

**为什么仓库里没有它**：这个 exe 约 158 MB，**超过 GitHub 单文件 100 MB 上限**，只能让你自行下载，`.gitignore` 里已排除 `dist-opencode/`。

也可以用 `npm i -g opencode-ai` 装到 PATH，启动时会自动检测到。两种都没有时，启动会弹一次提示——**「干活」功能不可用，聊天 / 划词翻译 / 截图识图完全不受影响**。

### 6. 启动

```bash
npm start
```

Electron 会自己拉起 Python 后端并连上 `ws://127.0.0.1:8765/ws`。想单独确认后端，浏览器打开 <http://127.0.0.1:8765/health> 应返回 `{"status":"ok",...}`。运行日志写在 `%APPDATA%\dandan-pet\dandan.log`（超过 1MB 每次启动自动清空）。

### 7. 第一次使用

右键蛋蛋 →「设置」→ 选服务 → 填 Key → 点 `↻` 拉取模型列表并选一个 → 选一个**工作目录**（干活时的沙箱，蛋蛋只在这个目录里动文件）→ 保存。

---

## 配置说明

`backend/config.yaml`（模板见 `backend/config.example.yaml`）分四段：

| 段 | 键 | 管什么 |
| --- | --- | --- |
| `chat` | `provider` | 当前用哪家服务（`deepseek` / `openai`）；设置窗那个下拉写的就是这一行 |
| | `max_history` | 最多带几轮历史对话给模型 |
| `chat.providers.<名字>` | `base_url` / `model` / `api_key` | 每家的接入地址、模型、密钥，**各存各的**，切换服务不用重填 |
| | `max_tokens_param` | 长度上限用哪个参数名（见下方「参数方言」） |
| | `supports_temperature` | 这家能不能传 `temperature` |
| `agent` | `enabled` | 干活功能总开关 |
| | `whitelist_dir` | 工作目录（沙箱），opencode 的 cwd；没配会引导你去设置窗 |
| | `timeout_seconds` | 单个任务最长等待秒数（默认 180） |
| | `mode` | 默认模式：`build`（可改文件）/ `plan`（只读，默认） |
| `proactive` | `enabled` | 主动触发总开关 |
| | `idle_reminder_seconds` | 多久没互动就主动打招呼（默认 900 秒） |
| | `hourly_chime` | 整点报时（默认 `false`） |
| | `watch_sandbox` | 监测工作目录出现新文件就提醒（默认 `true`） |
| `persona` | `pet_name` / `user_title` | 桌宠自称 / 对你的称呼 |
| | `system_prompt` | 人设提示词，`{pet_name}` `{user_title}` 会被上面两个值自动替换 |

### 参数方言（重要）

不同厂商对「长度上限」和「温度」这两个参数的要求不一样，所以每家 provider 下面各有一对开关：

```yaml
chat:
  providers:
    deepseek:
      max_tokens_param: max_tokens             # DeepSeek 用 max_tokens
      supports_temperature: true               # 可以自定义 temperature
    openai:
      max_tokens_param: max_completion_tokens  # 新一代模型传 max_tokens 会 400
      supports_temperature: false              # 只接受默认值，传 0 或 0.7 都会 400
```

OpenAI 新一代模型（gpt-5.x / o 系列）必须用 `max_completion_tokens`，且不接受自定义 `temperature`；DeepSeek 两个都吃。代码里只有 `provider_kwargs()`（Python 侧）和 `buildBody()`（Electron 侧）这两处消化这个差异，加新服务时照着填这两个键即可，一般不用改代码。

> 编辑 `config.yaml` 时注意：设置窗写回配置是**定向替换目标那一行**，不是整份重新序列化，所以你写在里面的中文注释不会被冲掉；但也请保持缩进结构不变。

---

## 隐私

API Key、长期记忆、对话上下文、日志全部留在本机（`backend/config.yaml`、`backend/memory.db`、`%APPDATA%\dandan-pet\`），只有你主动发起的聊天、翻译、识图和干活请求会发往**你自己配置的**那家大模型服务；本项目不设任何自有服务器，也不做遥测统计。详见 `PRIVACY.md`。

---

## 已知限制

- **仅支持 Windows 10/11 x64**。全屏检测走 PowerShell + user32.dll，划词翻译靠模拟 `Ctrl+C`，都是 Windows 专属实现，其它平台跑不起来。
- **`api.openai.com` 在中国大陆直连不通**，选 OpenAI 需要自备代理；DeepSeek 可直连。
- **opencode 需自行下载**（约 158 MB，超 GitHub 单文件上限）。没有它时「干活」不可用，其余功能正常。
- **`config.yaml` 以明文保存 API Key**，没有加密也没有接系统凭据管理器。请勿把它提交到仓库（`.gitignore` 已排除），也不要连同项目目录一起分享给别人。
- **暂无自动化测试**。`backend/test_echo.py` 只是一个早期的手动连通性自测脚本，不是测试套件。
- **安装包未做代码签名**，`npm run dist` 打出的安装包在 Windows 上会触发 SmartScreen 警告。
- 后端固定监听 `127.0.0.1:8765`，端口被占用时会连续快速退出并在 5 次后停止重启（日志里有提示），当前不支持改端口。
- 干活的边界靠 opencode 的工作目录（`whitelist_dir`）约束，`build` 模式是全自动批准的——请把工作目录指向一个你不介意被改动的文件夹。

---

## 许可

MIT License，见 `LICENSE`。作者：topworld29。

---

## English Summary

**dandan-pet (蛋蛋桌宠) v0.2.2** is a Windows desktop AI pet — a small egg-shaped character that lives on your desktop and doubles as an AI assistant.

**What it does.** A frameless, transparent, always-on-top overlay that stays click-through unless the cursor is actually on the character, never gets dragged off-screen, and hides itself automatically when a fullscreen app takes over. The character is drawn entirely in CSS and animates: breathing, random blinking, walking, talking, plus seven randomly-cycling moods. Beyond looks, it offers: a chat window with frosted-glass bubbles, a thinking placeholder and an interrupt button; agentic work through `opencode` in either `build` (read/write, fully automatic) or `plan` (read-only) mode, with streamed per-step progress and interruption; proactive nudges (idle reminders, new-file detection in the work directory); region-screenshot OCR; and hotkey translation of the current text selection with streaming output. Chat history is summarized when it grows past ~100k tokens, and durable facts about you are stored in a local SQLite file.

**Stack.** Three layers: an Electron shell (`main.js` / `preload.js` / `renderer/`), a Python FastAPI + WebSocket backend on `127.0.0.1:8765` (`backend/`), and `opencode` as the work engine, launched as a subprocess. The shell and the backend share one `backend/config.yaml`. Two model providers ship configured — DeepSeek and OpenAI — with separate stored credentials and models, switchable at runtime from the settings window.

**Platform limits.** Windows 10/11 x64 only (fullscreen detection and the selection-copy trick are Windows-specific). `api.openai.com` is not directly reachable from mainland China, so OpenAI needs a proxy there.

**Installing.** Grab `dandan-pet_<version>_Windows_x64.exe` from the [Releases](../../releases) page and run it — the Python backend and the agent core are bundled, so no Python or Node.js install is needed. The installer is unsigned, so Windows SmartScreen may warn on first run; verify the published SHA-256 first. The bundled config ships with empty API keys — you add your own in the settings window.

**Building from source.** Install Node.js 18+ and Python 3.10+, then `npm install`; create a venv under `backend/` and `pip install -r requirements.txt`; copy `backend/config.example.yaml` to `backend/config.yaml` and fill in your `api_key`; download the Windows x64 `opencode.exe` from <https://github.com/sst/opencode> releases into `dist-opencode/` (it is ~158 MB, over GitHub's 100 MB per-file limit, so it cannot be committed — without it only the agent feature is unavailable); then `npm start`.

**License.** MIT — see `LICENSE`.

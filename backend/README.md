# 蛋蛋桌宠 —— Python 后端

蛋蛋桌宠的 Python 后端：FastAPI + WebSocket，监听 `127.0.0.1:8765`（仅本机）。正常使用时由 Electron 主进程自动拉起并随桌宠退出；也可以脱离 Electron 单独启动，用于调试后端逻辑。

后端负责四件事：判断用户这句话是**闲聊**还是**干活**、调大模型闲聊、调 `opencode` 子进程干活并把进度流式推给前端、以及在没人理它的时候主动冒泡。

---

## 模块职责

| 文件 | 职责 |
|------|------|
| `server.py` | 服务入口。`FastAPI` 应用，暴露 HTTP `GET /health` 和 WebSocket `/ws`；用 `uvicorn` 跑在 `127.0.0.1:8765`。每条连接开 **reader / worker** 两个协程：reader 是唯一读 socket 的地方，负责分发控制消息（中断、确认、重载配置、切模式、清上下文），普通用户消息丢进队列；worker 从队列逐条处理。干活任务用 `asyncio` 子进程流式跑 opencode，边跑边推进度、随时可中断（Windows 下用 `taskkill /F /T` 杀掉整棵进程树，只杀外壳杀不干净）。启动时拉起主动触发引擎，并把 stdout/stderr 强制成 UTF-8（否则回复里的颜文字会让 Windows 控制台的 print 抛异常、拖垮连接）。 |
| `chat_llm.py` | 闲聊层。用 `openai` SDK 走 OpenAI 兼容接口（DeepSeek / OpenAI 都是同一套调用）。每次请求 = system（人设 + 长期记忆）+ 会话历史 + 本轮输入；历史按 `session_id` 存在内存 `deque` 里，另有 400 条硬上限。估算 token 超过 100k 时，自动把较旧的一半对话摘要压缩成一条 system 消息（`did_compact()` 供 `server.py` 读取后提示前端）。回复返回后，后台异步抽取新记忆，不阻塞。`reset_history()` 清空上下文。 |
| `agent_runner.py` | 干活层。`build_command()` 拼出 `opencode run --model <provider>/<model> --agent build\|plan --format json <任务>` 命令（build 模式追加 `--auto` 自动批准权限），工作目录锁死在配置里的 `agent.whitelist_dir`；`friendly_progress()` 把 opencode 的 json 事件翻译成给用户看的中文进度行（`🔧 写文件 xxx`、`💬 ...`）；`result_text()` 取最后一条 text 作为最终结果。`run_task()` 是保留下来的一次性阻塞模式，供测试兜底。未配置或工作目录不存在时，抛带 `__NO_WORKDIR__` 标记的 `AgentError`，`server.py` 据此发 `need_workdir` 事件引导用户去设置。 |
| `router.py` | 意图路由：判断一句话是 `chat` 还是 `task`。两段式——先做规则预筛（命中 `TASK_KEYWORDS` 里的动作词直接判 task，省一次调用），否则调一次轻量 LLM 分类（`temperature=0`、`max_tokens=4`，只输出一个词）。没配 key 或调用出错时保守返回 `chat`，避免误起 opencode 动用户的文件。 |
| `permission.py` | 权限网关。`classify_risk()` 按 `RISKY_KEYWORDS` 把任务分成 `safe` / `risky`。**注意当前 `needs_confirm()` 恒返回 `False`**：build 模式由 opencode `--auto` 自行批准、plan 模式只读不改文件，所以后端这一层不再弹确认框。`server.py` 里的 `confirm` / `confirm_result` 协议保留着，但当前不会被触发。 |
| `memory.py` | 长期记忆。本地 SQLite（`facts` 表，`content` 唯一，`INSERT OR IGNORE` 去重），全部存在本机、不上传。闲聊前 `format_for_prompt()` 把事实拼进 system 提示词；闲聊后 `extract_and_store_async()` 起后台线程调模型抽取「关于主人」的新事实写回。数据库路径为 `config.BASE_DIR/memory.db`。 |
| `proactive.py` | 主动触发引擎。`APScheduler`（`AsyncIOScheduler`，与 FastAPI 共用同一事件循环）每 20 秒查一次久坐——超过 `idle_reminder_seconds` 没动静就随机挑一句冒泡；可选整点报时（默认关）。`watchdog` 的 `Observer` 监测白名单沙箱目录（非递归）出现新文件就提醒。所有主动消息以 `type=reply` 广播给全部活动连接。`suppress_files()` 开一个屏蔽窗口，避免任务自己刚建的文件被当成「新文件」重复播报。 |
| `config.py` | 配置加载。`yaml.safe_load` 读 `BASE_DIR/config.yaml`，`@lru_cache(maxsize=1)` 缓存；`reload_config()` 清缓存实现热更新——前端设置窗改完 key 发一条 `reload_config`，下次读配置就是新值，不用重启后端。按块取用：`get_chat_provider()` / `get_agent()` / `get_proactive()` / `get_persona()`（人设里的 `{pet_name}`、`{user_title}` 在这里渲染）。`provider_kwargs()` 抹平各家的「参数方言」（长度上限用哪个参数名、能不能传 temperature）。`BASE_DIR` 随 `sys.frozen` 切换，见下方「打包成 exe」。 |
| `test_echo.py` | 自测脚本。先 `GET /health`，再连 `ws://127.0.0.1:8765/ws` 发两条消息并打印回复。需要 `websockets` 包。注意它第二条发的是「整理一下文件夹」，会被路由判成 task 真的去跑 opencode——只想验证连通性的话，把它换成一句闲聊更省事。 |
| `dandan-backend.spec` | PyInstaller 打包配置：入口 `server.py`，产物名 `dandan-backend`，`console=True`，`COLLECT` 目录模式（exe + `_internal/`）。`datas` 为空，**配置文件不会被打进包**。 |
| `config.example.yaml` | 配置模板，所有 key 留空。四大块：`chat`（选哪家服务、各家的 `base_url`/`model`/`api_key`/参数方言、`max_history`）、`agent`（`enabled`、白名单工作目录 `whitelist_dir`、`timeout_seconds`、`mode`）、`proactive`（久坐阈值、整点报时、沙箱监测开关）、`persona`（自称、对用户的称呼、人设提示词）。复制成 `config.yaml` 后再填；`config.yaml` 已被 `.gitignore` 排除，不会进版本库。 |

---

## WebSocket 协议

连接地址 `ws://127.0.0.1:8765/ws`。所有消息都是一行 JSON（`ensure_ascii=False`）。

### 前端 → 后端

| 消息 | 含义 |
|------|------|
| `{"text": "..."}` | 用户消息。也接受**非 JSON 的纯文本**，整条当作用户输入。经 `router` 判成 chat 或 task 后分别处理。 |
| `{"type": "interrupt"}` | 中断。正在跑的干活任务杀掉整棵子进程树；正在等的闲聊回复打上标记，回来后直接丢弃不显示。 |
| `{"type": "set_mode", "mode": "build", "silent": false}` | 切换运行模式，`mode` 取 `build` 或 `plan`，无法识别的值一律回落到 `plan`（只读）。`silent=true` 时只同步不回聊天提示（如打开聊天框时的自动重置）。 |
| `{"type": "clear_context", "silent": false}` | 清空闲聊上下文（手动按钮 / 闲置自动触发）。 |
| `{"type": "reload_config"}` | 重载 `config.yaml`（清掉配置缓存），用于设置窗改完 key 后热更新。 |
| `{"type": "confirm_result", "id": "...", "ok": true}` | 风险任务确认结果，`id` 要与后端发来的 `confirm` 对上。（协议保留，当前不会被触发，见 `permission.py`） |
| 其它带 `type` 但不带 `text` 的消息 | 视为未知控制消息：打一行日志后忽略，**不会**被当成用户输入喂给大模型。 |

### 后端 → 前端

| 消息 | 含义 |
|------|------|
| `{"type": "reply", "text": "..."}` | 最终回复。闲聊回复、任务完成回报、主动提醒都走这一种。 |
| `{"type": "mode", "mode": "build"}` | 当前运行模式。连接建立时主动推一次；`set_mode` 之后回推一次，便于前端下拉框同步。 |
| `{"type": "exec_start"}` | 干活任务开始执行，前端可以显示执行面板。 |
| `{"type": "exec_progress", "text": "🔧 写文件 a.txt"}` | 执行过程中的一行进度（正在做什么）。超时时也会推一条 `⏱ 任务超时，已停止`。 |
| `{"type": "context_compacted", "text": "..."}` | 本轮聊天触发了上下文摘要压缩的提示，紧接着才是 `reply`。 |
| `{"type": "context_cleared"}` | 上下文已清空的回执。 |
| `{"type": "need_workdir", "text": "..."}` | 没配工作目录、或配的目录不存在。前端可据此引导用户去设置；后端随后还会补发一条同文案的 `reply`。 |
| `{"type": "confirm", "id": "...", "text": "..."}` | 请求确认风险任务，等前端回 `confirm_result`。（协议保留，当前不会被触发） |

---

## 独立运行（调试用）

Electron 会自动拉起后端，**只有单独调试后端时才需要手动来这一套**。如果桌宠正开着，`8765` 端口已被占用，先退出桌宠再手动启动。

以下命令都在 `backend/` 目录下用 PowerShell 执行。

### 1. 建虚拟环境、装依赖

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
```

`venv/` 已被 `.gitignore` 排除，clone 下来的仓库里没有，需要自己建。开发环境实测用的是 Python 3.14。

> `requirements.txt` 已登记后端**直接 import** 的全部第三方包并用 `==` 锁定版本：除 `fastapi` / `uvicorn[standard]` / `openai` / `PyYAML` 外，还有 `APScheduler`（`proactive.py` 的定时器）、`watchdog`（沙箱文件监测）和 `websockets`（`test_echo.py` 用）。装完即可直接启动，不需要再手动补包。

### 2. 准备配置

```powershell
copy config.example.yaml config.yaml
```

然后编辑 `config.yaml`，至少填两处：

- `chat.providers.<当前 provider>.api_key` —— 大模型 key
- `agent.whitelist_dir` —— 蛋蛋能动手的白名单工作目录（不填则干活功能会提示去设置）

`config.yaml` 含真实 key，已在 `.gitignore` 里，**不要提交**。

### 3. 启动

```powershell
.\venv\Scripts\python.exe server.py
```

看到 `Uvicorn running on http://127.0.0.1:8765` 即启动成功，`Ctrl+C` 停止。

### 4. 验证

**方法一：健康检查**

```powershell
curl http://127.0.0.1:8765/health
```

应返回 `{"status":"ok","service":"dandan-backend","time":"..."}`。浏览器直接打开这个地址也行。

**方法二：自测脚本**（另开一个 PowerShell 窗口）

```powershell
$env:PYTHONUTF8=1; .\venv\Scripts\python.exe test_echo.py
```

会先打印 `/health` 的返回，再打印两条 WebSocket 消息的回复。

> `$env:PYTHONUTF8=1` 只是让中文在终端正常显示，不影响功能。

---

## 打包成 exe

`dandan-backend.spec` 是 PyInstaller 的打包配置，把 `server.py` 及其依赖冻结成 `dandan-backend.exe`，这样发行版里不需要用户自己装 Python。

```powershell
.\venv\Scripts\python.exe -m PyInstaller dandan-backend.spec
```

产物是一个目录（`COLLECT` 模式）：`dandan-backend.exe` + 同级的 `_internal/`。Electron 主进程发现后端目录里有 `dandan-backend.exe` 就优先用它，否则回退到用 Python 跑 `server.py`。

### ⚠ 冻结后配置和记忆库的位置会变

`config.py` 里有这段 `sys.frozen` 判断，它定义了整个后端的「基准目录」：

```python
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)   # 打包：exe 所在目录
else:
    BASE_DIR = os.path.dirname(__file__)         # 开发：源码目录
```

- **开发模式**：`BASE_DIR` = 源码目录 → 读 `backend/config.yaml`
- **冻结成 exe 后**：`BASE_DIR` = **exe 所在目录** → 读 exe 旁边的 `config.yaml`

因为 PyInstaller 会把 `__file__` 指向解包出来的临时目录，那里放配置没有意义（每次启动都变、用户也改不到）。

`memory.py` 没有自己的判断，它直接复用 `config.BASE_DIR` 拼 `DB_PATH = BASE_DIR/memory.db`，所以 `memory.db` 同样跟着 exe 走。

**这意味着**：spec 里 `datas=[]`，`config.yaml` 不会被打进包，**分发时必须手动把 `config.yaml` 放到 `dandan-backend.exe` 旁边**，否则后端一启动就会因为找不到配置而退出。`memory.db` 首次运行会自动建。

---

## 相关文档

项目整体介绍见根目录的 `README.md`，架构设计与模块交互见 `docs/ARCHITECTURE.md`。

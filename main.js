/* ============================================================
   蛋蛋桌宠 · Electron 主进程 (main.js)
   阶段 0：透明置顶浮窗骨架（原生拖动 / 点击穿透 / 自定义右键菜单 / 防丢失）
   阶段 1：眨眼 / 偶尔走(现改手动) / 呼吸 都在渲染层
   阶段 2：接上 Python 大脑——主进程持有 WebSocket，聊天窗 + 全局快捷键
   ============================================================ */
const { app, BrowserWindow, ipcMain, screen, Menu, globalShortcut, clipboard, dialog, Tray } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const WebSocketClient = require("ws");
const yaml = require("js-yaml");

/* ---- 落盘日志：打包版没有控制台，出问题（如"蛋蛋突然消失"）全靠这个查 ----
   位置：%APPDATA%\dandan-pet\dandan.log；每次启动若超过 1MB 先清空。 */
const LOG_PATH = path.join(app.getPath("userData"), "dandan.log");
try { if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1024 * 1024) fs.unlinkSync(LOG_PATH); } catch (e) {}
const _rawLog = console.log.bind(console);
console.log = (...args) => {
  _rawLog(...args);
  try {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    fs.appendFileSync(LOG_PATH, `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}\n`);
  } catch (e) {}
};
console.log(`[app] 启动 pid=${process.pid} packaged=${app.isPackaged} v=${app.getVersion()}`);
process.on("uncaughtException", (err) => {
  console.log("[app] 主进程未捕获异常：" + (err && err.stack || err));
});
process.on("exit", (code) => { try { fs.appendFileSync(LOG_PATH, `[${new Date().toLocaleString("zh-CN", { hour12: false })}] [app] 进程退出 code=${code}\n`); } catch (e) {} });

let win = null;      // 蛋蛋浮窗
let chatWin = null;  // 聊天窗
let transWin = null; // 翻译结果浮窗
let settingsWin = null; // 设置窗
let ocrWin = null;   // 图片识别窗
let cropWin = null;  // 截图区域选择窗
let tray = null;     // 系统托盘

const WIN_W = 220;
const WIN_H = 240;

/* ============================================================
   蛋蛋浮窗
   ============================================================ */
function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const x = Math.max(0, workAreaSize.width - WIN_W - 40);
  const y = Math.max(0, workAreaSize.height - WIN_H - 20);

  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, x, y,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false,
    fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 安全网：确保蛋蛋至少露出一部分在屏幕内（走路后 ensureVisible() 会额外调一次）
  setInterval(ensureVisible, 10000);

  // 聊天闲置自动清空上下文：每分钟检查一次
  setInterval(checkIdleClear, 60 * 1000);

  // 命中检测：每 80ms 纯光标比对（零开销，不 spawn 任何进程）
  setInterval(hitTest, 80);

  // 全屏检测：启动一个常驻观察进程（每 3 秒吐一行 "1"/"0"）
  // 首次延迟 2 秒，等窗口完全渲染完再开始，避免启动时误判隐藏
  setTimeout(startFullscreenWatcher, 2000);

}

/* ---- 穿透切换：光标在蛋蛋身上 → 可交互；否则穿透 ---- */
// 蛋蛋在窗口内的矩形（与 pet.css 的 #pet 保持一致：110×130，底部居中，bottom 12px）
const PET_RECT = { x: (WIN_W - 110) / 2, y: WIN_H - 12 - 130, w: 110, h: 130 };
let interactiveNow = false;
let petDragging = false;   // 正在手动拖动蛋蛋 → 暂停穿透切换，避免打断拖动
let fullscreenHidden = false;
let userOverrodeFullscreen = false; // 用户主动点了"显示蛋蛋"→暂停自动隐藏，直到下次全屏退出再重置

/* ---- 全屏检测：常驻 PowerShell 观察进程 ----
   旧方案每 3 秒 spawn 一个新 PowerShell 并重新编译一次 C#（Add-Type 每次都调编译器），
   是常驻 CPU 开销的大头。现在整个生命周期只启动一个进程：编译一次，之后每 3 秒
   吐一行 "1"/"0"，闲时只在 sleep，几乎零开销。Electron 退了它自己会跟着退。 */
// 打包后本文件在 app.asar 里，外部 powershell.exe 读不进 asar；
// 打包配置已把该脚本 asarUnpack 到 app.asar.unpacked，这里把路径映射过去（开发模式不受影响）
const FS_SCRIPT = path.join(__dirname, "check-fullscreen.ps1").replace("app.asar", "app.asar.unpacked");
let fsProc = null;

function handleFsSample(sample) {
  if (petDragging) return; // 拖动中忽略本轮采样，别打断拖动
  // 自家截图遮罩(cropWin)本身就是全屏窗口，别把它误判成"全屏应用"藏起蛋蛋
  if (cropWin && !cropWin.isDestroyed() && cropWin.isVisible()) return;
  const isFs = sample === "1";
  if (isFs) {
    // 有全屏应用在前台：除非用户主动覆盖，否则隐藏蛋蛋
    if (!fullscreenHidden && !userOverrodeFullscreen) {
      fullscreenHidden = true;
      if (win && !win.isDestroyed()) win.hide();
      console.log("[fullscreen] 检测到全屏应用，蛋蛋隐藏");
    }
  } else {
    // 没有全屏应用：重置覆盖标记（不依赖 fullscreenHidden，避免标记卡死）
    userOverrodeFullscreen = false;
    if (fullscreenHidden) {
      fullscreenHidden = false;
      if (win && !win.isDestroyed()) {
        win.show();
        win.setAlwaysOnTop(true, "screen-saver");
      }
      console.log("[fullscreen] 全屏退出，蛋蛋恢复");
    }
  }
}

function startFullscreenWatcher() {
  if (appQuitting || fsProc) return;
  try {
    fsProc = spawn("powershell", [
      "-ExecutionPolicy", "Bypass", "-NoProfile", "-NonInteractive",
      "-WindowStyle", "Hidden", "-File", FS_SCRIPT, String(process.pid)
    ], { windowsHide: true });
  } catch (e) { fsProc = null; return; }
  let buf = "";
  fsProc.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop(); // 最后一段可能是半行，留着拼下一次
    for (const line of lines) {
      const s = line.trim();
      if (s === "0" || s === "1") handleFsSample(s);
    }
  });
  fsProc.on("error", () => {});
  fsProc.on("exit", () => {
    fsProc = null;
    if (!appQuitting) setTimeout(startFullscreenWatcher, 5000); // 意外挂了 → 5 秒后重启
  });
}

function hitTest() {
  if (!win || win.isDestroyed()) return;
  if (fullscreenHidden) return;
  if (!win.isVisible()) return;  // 蛋蛋被隐藏（托盘"隐藏蛋蛋"等）→ 不用轮询
  if (petDragging) return;   // 拖动中：保持可交互，别让穿透切换打断拖动

  // 纯光标比对，零开销（不调 PowerShell、不读文件）
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside =
    c.x >= b.x + PET_RECT.x && c.x <= b.x + PET_RECT.x + PET_RECT.w &&
    c.y >= b.y + PET_RECT.y && c.y <= b.y + PET_RECT.y + PET_RECT.h;
  if (inside !== interactiveNow) {
    interactiveNow = inside;
    if (inside) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  }
}

/* ---- 兜底：保证蛋蛋至少露出 MIN_VISIBLE 像素在屏幕内 ---- */
const MIN_VISIBLE = 44;
function petWorkArea() {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({
    x: b.x + Math.round(b.width / 2),
    y: b.y + Math.round(b.height / 2),
  }).workArea;
}
function ensureVisible() {
  if (!win || win.isDestroyed()) return;
  if (petDragging) return;  // 10 秒兜底定时器可能在拖动中途触发，别跟拖动抢位置
  const a = petWorkArea();
  if (!a) return;
  const b = win.getBounds();
  const x = Math.max(a.x - (b.width - MIN_VISIBLE), Math.min(a.x + a.width - MIN_VISIBLE, b.x));
  const y = Math.max(a.y - (b.height - MIN_VISIBLE), Math.min(a.y + a.height - MIN_VISIBLE, b.y));
  if (x !== b.x || y !== b.y) win.setBounds({ x, y, width: WIN_W, height: WIN_H });
}

/* ---- 手动拖动蛋蛋：事件驱动，窗口随光标实时移动 ----
   取代 -webkit-app-region:drag —— 透明置顶窗口用系统原生拖动，有概率在拖动结束后
   不重绘合成层导致窗口"消失"。这里由渲染层的 mousemove 直接驱动 setBounds，
   随鼠标事件速率移动（不是定时轮询），跟手且不卡。
   坐标全用渲染层的 screenX/screenY（CSS/DIP 像素），与 getBounds 同一单位，不受缩放影响。 */
let petDragBaseWin = null;    // 按下瞬间的窗口位置
let petDragBaseCur = null;    // 按下瞬间的光标屏幕坐标
ipcMain.on("pet-drag-start", (_e, sx, sy) => {
  if (!win || win.isDestroyed()) return;
  if (walkTimer) stopWalk();  // 走路中被抓住 → 先停走路，否则两边抢着 setBounds 会抽搐
  petDragging = true;
  petDragBaseWin = win.getBounds();
  petDragBaseCur = { x: sx, y: sy };
});
ipcMain.on("pet-drag-move", (_e, sx, sy) => {
  if (!petDragging || !petDragBaseWin || !win || win.isDestroyed()) return;
  win.setBounds({
    x: Math.round(petDragBaseWin.x + (sx - petDragBaseCur.x)),
    y: Math.round(petDragBaseWin.y + (sy - petDragBaseCur.y)),
    width: WIN_W, height: WIN_H,
  });
});
ipcMain.on("pet-drag-end", () => {
  petDragging = false;
  petDragBaseWin = null;
  petDragBaseCur = null;
  ensureVisible();   // 松手后确保没被拖出屏幕
});

// 右键蛋蛋 → 弹出小菜单（取代原 system-context-menu 事件，那个只在原生拖动区才触发）
ipcMain.on("show-pet-menu", () => showPetMenu());

/* ---- 走两步（右键「遛一遛」手动触发）----
   全局只允许一个走路任务（连点菜单不叠加）；每一步都实时按屏幕边界钳制，
   途中无论位置被谁挪过、跨没跨屏，都绝不会走出可视区。 */
let walkTimer = null;

function stopWalk() {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
  if (win && !win.isDestroyed()) win.webContents.send("walk-end");
}

function clampX(x, area, width) {
  return Math.max(area.x, Math.min(area.x + area.width - width, x));
}

function walkOnce(forceDir) {
  if (!win || win.isDestroyed()) return;
  if (petDragging) return;   // 正被拖着 → 不开始走路，避免两边抢位置
  stopWalk();                                   // 已经在走就先停，绝不叠加
  const area = petWorkArea();
  const b = win.getBounds();
  const dir = forceDir || (Math.random() < 0.5 ? -1 : 1);
  const dist = 60 + Math.random() * 140;
  const targetX = clampX(Math.round(b.x + dir * dist), area, b.width);
  if (targetX === b.x) { console.log(`[walk] 已贴边，不走 b.x=${b.x}`); return; }
  const realDir = targetX > b.x ? 1 : -1;
  console.log(`[walk] start b=(${b.x},${b.y}) target=${targetX} area=[${area.x},${area.x + area.width}]`);
  win.webContents.send("walk-start", realDir);
  const step = 2 * realDir;
  walkTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopWalk(); return; }
    const cur = win.getBounds();
    const a = petWorkArea();                    // 每步都取最新工作区（防跨屏/任务栏变化）
    let nx = cur.x + step;
    if ((realDir > 0 && nx >= targetX) || (realDir < 0 && nx <= targetX)) nx = targetX;
    nx = clampX(nx, a, cur.width);              // 每步硬钳制：无论如何不出屏
    // 用 setBounds 显式带宽高：setPosition 在 175% 缩放+不可缩放窗口下会把位置带偏（往右走实测倒退）
    win.setBounds({ x: nx, y: cur.y, width: WIN_W, height: WIN_H });
    // 到达目标，或被边界卡住走不动了 → 收尾
    if (nx === targetX || nx === cur.x) {
      stopWalk();
      const e = win.getBounds();
      console.log(`[walk] end b=(${e.x},${e.y})`);
      ensureVisible();
    }
  }, 28);
}

/* ---- 右键小菜单 ---- */
function showPetMenu() {
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { label: "和蛋蛋聊天", click: () => openChat() },
    { label: "遛一遛", click: () => walkOnce() },
    { label: "图片识别", click: () => doOCR() },
    { label: "设置", click: () => openSettings() },
    { type: "separator" },
    { label: "退出蛋蛋", click: () => quitApp() },
  ]);
  menu.popup({
    window: win,
    // 菜单关闭后强制按当前光标位置重新应用一次穿透状态（防任何残留不同步）
    callback: () => {
      if (!win) return;
      interactiveNow = !interactiveNow; // 打破"没变就不重发"，让 hitTest 必定重设
      hitTest();
    },
  });
}

/* ============================================================
   阶段 2：Python 大脑（聊天）
   ============================================================ */
/* ---- 后端目录：不写死绝对路径，按顺序自动寻找（为打包分享做准备）----
   1) 环境变量 DANDAN_BACKEND_DIR（手动指定，最高优先级）
   2) 打包后：安装目录的 resources/backend（electron-builder extraResources 会放这里）
   3) 开发时：dandan-pet/backend（源码就在项目里，整个项目自包含）
   4) 旧布局兜底：与 dandan-pet 同级的 桌宠制作/backend（2026-08-22 之前后端放在那儿） */
function resolveBackendDir() {
  const candidates = [];
  if (process.env.DANDAN_BACKEND_DIR) candidates.push(process.env.DANDAN_BACKEND_DIR);
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, "backend"));
  candidates.push(path.join(__dirname, "backend"));
  candidates.push(path.join(__dirname, "..", "桌宠制作", "backend"));  // 旧布局兜底
  for (const c of candidates) {
    // 有 server.py（开发源码）或 dandan-backend.exe（打包后的冻结后端）都算有效
    try {
      if (fs.existsSync(path.join(c, "server.py")) || fs.existsSync(path.join(c, "dandan-backend.exe"))) return c;
    } catch (e) {}
  }
  return candidates[candidates.length - 1]; // 都没找到 → 返回开发路径，startBackend 会打日志提示
}
const BACKEND_DIR = resolveBackendDir();
const BACKEND_EXE = path.join(BACKEND_DIR, "dandan-backend.exe"); // 打包版：PyInstaller 冻结后端
// python：优先用后端自带的 venv；没有就退回系统 PATH 里的 python（别人机器上未必建过 venv）
const VENV_PY = path.join(BACKEND_DIR, "venv", "Scripts", "python.exe");
const BACKEND_PY = fs.existsSync(VENV_PY) ? VENV_PY : "python";
const CONFIG_YAML = path.join(BACKEND_DIR, "config.yaml");  // 全部 config.yaml 读写共用这一个路径
const WS_URL = "ws://127.0.0.1:8765/ws";

/* ---- 内置 opencode（干活内核）----
   打包时把官方独立版 opencode.exe 放进 resources/opencode（无需 Node.js），
   拉起后端时把该目录插到 PATH 最前——后端 shutil.which("opencode") 就会先找到它，
   朋友装完蛋蛋即可让它干活，不用再装任何东西。开发目录的 dist-opencode 同样生效。 */
function bundledOpencodeDir() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, "opencode"));
  candidates.push(path.join(__dirname, "dist-opencode"));
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, "opencode.exe"))) return c; } catch (e) {}
  }
  return null;
}
const OPENCODE_DIR = bundledOpencodeDir();

// 给后端用的环境变量：把内置 opencode 目录插到 PATH 最前。
// 注意 Windows 上 PATH 的键名可能是 "Path"，直接加 "PATH" 会出现大小写重复键，行为不确定。
function envForBackend() {
  const env = { ...process.env };
  if (OPENCODE_DIR) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    env[key] = OPENCODE_DIR + path.delimiter + (env[key] || "");
  }
  // opencode 首次干活要从 npm 官方源现场下载模型适配包，国内网络会无输出卡死
  // （表现为"任务超时，已停止"，2026-07-06 实测）。未设置时指向国内镜像；用户自己设过则尊重。
  if (!env.NPM_CONFIG_REGISTRY) env.NPM_CONFIG_REGISTRY = "https://registry.npmmirror.com";
  return env;
}

let backendProc = null;
let ws = null;
let wsReady = false;
let backendStartAt = 0;      // 本次后端 spawn 的时刻，用于判断"快速失败"
let backendFastFails = 0;    // 连续"启动没多久就退出"的次数
const BACKEND_FAST_MS = 8000;      // 8 秒内就退出算快速失败（多半是端口占用/启动即崩）
const BACKEND_MAX_FAST_FAILS = 5;  // 连续 5 次快速失败就停手，不再无限重启

/* 拉起 Python 后端（若端口已被别的后端占用，这个会快速退出——WS 会自行连上那个）*/
function startBackend() {
  // 打包版优先：exe 后端（无需 Python）；否则用源码 + python
  const useExe = fs.existsSync(BACKEND_EXE);
  if (!useExe && !fs.existsSync(path.join(BACKEND_DIR, "server.py"))) {
    console.log("[backend] 找不到后端目录：" + BACKEND_DIR + "（聊天/干活不可用；可用环境变量 DANDAN_BACKEND_DIR 指定）");
    return;
  }
  try {
    backendStartAt = Date.now();
    // stdin 给 'ignore'：后端及其子进程（opencode）都不该继承一根永不关闭的管道，
    // 否则 opencode 会当成"管道喂任务"傻等 EOF → 任务零输出直到超时
    backendProc = useExe
      ? spawn(BACKEND_EXE, [], { cwd: BACKEND_DIR, windowsHide: true, env: envForBackend(), stdio: ["ignore", "pipe", "pipe"] })
      : spawn(BACKEND_PY, ["server.py"], { cwd: BACKEND_DIR, env: envForBackend(), stdio: ["ignore", "pipe", "pipe"] });
    backendProc.on("error", (err) => { console.log("[backend] 启动失败：" + err.message); backendProc = null; });
    backendProc.stdout.on("data", (d) => console.log("[backend] " + d.toString().trimEnd()));
    backendProc.stderr.on("data", (d) => console.log("[backend] " + d.toString().trimEnd()));
    backendProc.on("exit", (c) => {
      console.log("[backend] 退出 code=" + c);
      backendProc = null;
      if (appQuitting) return;
      const uptime = Date.now() - backendStartAt;
      if (uptime < BACKEND_FAST_MS) {
        backendFastFails++;
        if (backendFastFails >= BACKEND_MAX_FAST_FAILS) {
          console.log(`[backend] 连续 ${backendFastFails} 次快速退出（可能端口 8765 被占用），停止自动重启。若外部已有后端，WS 会自行连上；否则请检查后端。`);
          return; // 不再无限重启
        }
      } else {
        backendFastFails = 0; // 健康运行过一段 → 重置计数
      }
      const delay = Math.min(5000 * backendFastFails || 5000, 30000); // 失败越多退避越久，封顶 30s
      console.log(`[backend] ${Math.round(delay / 1000)} 秒后自动重启…（连续快速失败 ${backendFastFails} 次）`);
      setTimeout(startBackend, delay);
    });
  } catch (e) {
    console.log("[backend] 启动失败：" + e.message);
  }
}
function stopBackend() {
  if (backendProc && backendProc.pid) {
    try { spawn("taskkill", ["/F", "/T", "/PID", String(backendProc.pid)]); } catch (e) {}
  }
}

/* ---- 聊天模式记忆：记住上次的选择（plan/build），重启蛋蛋也不丢 ---- */
const UI_STATE_PATH = path.join(app.getPath("userData"), "ui-state.json");
function getSavedMode() {
  try {
    const obj = JSON.parse(fs.readFileSync(UI_STATE_PATH, "utf8"));
    return obj.mode === "build" ? "build" : "plan"; // 只认这两个值；首次运行默认 plan（更安全）
  } catch (e) { return "plan"; }
}
function saveMode(mode) {
  try { fs.writeFileSync(UI_STATE_PATH, JSON.stringify({ mode }, null, 2), "utf8"); } catch (e) {}
}

/* 主进程统一持有 WebSocket，自动重连 */
function connectWS() {
  try {
    ws = new WebSocketClient(WS_URL);
    ws.on("open", () => {
      wsReady = true; backendFastFails = 0; console.log("[ws] connected"); broadcast({ kind: "conn", ok: true });
      // 连上后端后恢复上次选择的模式（silent：不让蛋蛋念"已切换"）
      sendToBackend({ type: "set_mode", mode: getSavedMode(), silent: true });
    });
    ws.on("message", (data) => {
      let obj; try { obj = JSON.parse(data.toString()); } catch (e) { return; }
      broadcast({ kind: "ai", msg: obj });
      // 聊天窗关着时，回复/主动提醒 在蛋蛋头顶冒气泡，避免错过
      if (obj.type === "reply" && win && (!chatWin || !chatWin.isVisible())) {
        win.webContents.send("pet-bubble", obj.text);
        console.log("[bubble] " + String(obj.text).slice(0, 40));
      }
    });
    ws.on("close", () => { wsReady = false; broadcast({ kind: "conn", ok: false }); setTimeout(connectWS, 1500); });
    ws.on("error", () => { /* 交给 close 处理重连 */ });
  } catch (e) {
    setTimeout(connectWS, 1500);
  }
}
// 聊天闲置到达时长后，蛋蛋主动询问是否清空（不直接清）
const IDLE_CLEAR_MS = 60 * 60 * 1000; // 60 分钟
let lastChatActivity = Date.now();
let contextEmpty = true;   // 上下文是否已空（空则无需再问）
let idlePromptShown = false; // 已经问过、等用户回答，避免重复问

function sendText(text) {
  if (ws && wsReady) {
    ws.send(JSON.stringify({ text }));
    lastChatActivity = Date.now();
    contextEmpty = false;
    idlePromptShown = false;
    return true;
  }
  return false;
}

function checkIdleClear() {
  if (contextEmpty || idlePromptShown) return;
  if (Date.now() - lastChatActivity >= IDLE_CLEAR_MS) {
    // 不直接清，发一个带"是/否"的询问气泡给聊天窗
    idlePromptShown = true;
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send("ai-event", { kind: "ai", msg: { type: "clear_prompt" } });
    }
    console.log("[chat] 闲置超过 60 分钟，已询问是否清空对话");
  }
}
function sendToBackend(obj) {
  if (ws && wsReady && obj && typeof obj === "object") {
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) {}
  }
  return false;
}
function broadcast(payload) {
  [win, chatWin].forEach((w) => { if (w && !w.isDestroyed()) w.webContents.send("ai-event", payload); });
}

/* 聊天窗（第二个窗口，不透明，像素风）*/
function createChatWindow() {
  // 普通窗口（不置顶）：点别的窗口会正常盖住它，点它/点标题栏又正常浮上来，
  // 与其它软件的窗口行为一致（曾试过置顶方案——盖住别的窗口，用户不要）
  chatWin = new BrowserWindow({
    // 520 = 工具条（模式选择+静音+清空+干活中+中断）一行放下不换行所需宽度（实测 512 + 余量）
    width: 520, height: 520, show: false, frame: false, resizable: true,
    skipTaskbar: true, hasShadow: false, minWidth: 300, minHeight: 360,
    transparent: true,  // 圆角透明背景
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  chatWin.loadFile(path.join(__dirname, "renderer", "chat.html"));
  chatWin.on("close", (e) => { if (!appQuitting) { e.preventDefault(); chatWin.hide(); } }); // 关闭只隐藏，保留历史；退出时放行
}
function positionChat() {
  if (!win || !chatWin) return;
  const b = win.getBounds();
  const c = chatWin.getBounds();
  const a = petWorkArea();
  let x = b.x + b.width - c.width;   // 右边与蛋蛋对齐
  let y = b.y - c.height - 8;        // 放蛋蛋上方
  x = Math.max(a.x, Math.min(a.x + a.width - c.width, x));
  y = Math.max(a.y, Math.min(a.y + a.height - c.height, y));
  chatWin.setPosition(Math.round(x), Math.round(y));
}
function openChat() {
  if (!chatWin) return;
  positionChat();
  chatWin.show();
  chatWin.moveTop();
  chatWin.focus();
  // 不再强制重置为计划模式——模式记住上次的选择（见 getSavedMode/saveMode）
}
function toggleChat() {
  if (!chatWin) return;
  if (chatWin.isVisible()) chatWin.hide();
  else openChat();
}

/* 设置窗 */
function createSettingsWindow() {
  settingsWin = new BrowserWindow({
    width: 360, height: 520, show: false, frame: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    transparent: true, resizable: true, minWidth: 320, minHeight: 420,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWin.on("close", (e) => { if (!appQuitting) { e.preventDefault(); settingsWin.hide(); } });
}
function openSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) createSettingsWindow();
  if (win) {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = d.workArea;
    settingsWin.setPosition(wa.x + Math.round((wa.width - 360) / 2), wa.y + Math.round((wa.height - 520) / 2));
  }
  settingsWin.show();
  settingsWin.focus();
  // 复用的窗口再次打开时，让表单回到已保存状态（丢弃上次没保存的改动）。
  // 首次打开还在加载 → settings.js 的初始化会自己读取，无需再发。
  if (!settingsWin.webContents.isLoading()) {
    settingsWin.webContents.send("settings-refresh");
  }
}
/* ---- 后端 config.yaml 读写 ----
   读：js-yaml 真解析。以前是"数第几个 api_key"，往 config.yaml 加一家服务就会整体串位，现在不会了。
   写：只对目标那一行做定向替换 —— 不能用 yaml.dump()，那会把 config.yaml 里写给你看的中文注释全冲掉。*/

// 服务名 → 设置窗下拉里显示的名字。这里的服务名同时也是 opencode 的 provider id，
// 所以干活时的模型串直接就是 "<服务名>/<模型名>"，不需要再做映射。
const PROVIDER_LABELS = { deepseek: "DeepSeek", openai: "OpenAI" };

function readConfig() {
  try { return yaml.load(fs.readFileSync(CONFIG_YAML, "utf8")) || {}; }
  catch (e) { console.log("[config] 读取失败：" + e.message); return {}; }
}

// 当前选中的服务：聊天/翻译/识图/干活全都从这里拿 base_url + model + key
function getActiveProvider() {
  const chat = readConfig().chat || {};
  const name = chat.provider || "deepseek";
  const p = (chat.providers || {})[name] || {};
  return {
    name,
    base_url: String(p.base_url || "").replace(/\/+$/, ""),
    model: p.model || "",
    api_key: p.api_key || "",
    // 参数方言，缺省按 DeepSeek 那套（多数 OpenAI 兼容服务都吃这套）
    maxTokensParam: p.max_tokens_param || "max_tokens",
    supportsTemperature: p.supports_temperature !== false,
  };
}

function getProviderField(name, field) {
  const chat = readConfig().chat || {};
  const p = (chat.providers || {})[name];
  return (p && p[field]) || "";
}

// 定位到 chat.providers.<name> 块里的某一行（api_key / model）做替换，块外一字不动
function setProviderFieldInConfig(name, field, value) {
  try {
    const src = fs.readFileSync(CONFIG_YAML, "utf8");
    const eol = src.includes("\r\n") ? "\r\n" : "\n";
    const lines = src.split(/\r?\n/);
    const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const head = new RegExp("^(\\s+)" + esc(name) + ":\\s*(?:#.*)?$");
    const i = lines.findIndex((l) => head.test(l));
    if (i < 0) return false;
    const indent = lines[i].match(head)[1].length;
    const row = new RegExp("^(\\s*" + esc(field) + ":\\s*)(?:\"[^\"]*\"|'[^']*'|[^#\\s]*)(\\s*(?:#.*)?)$");
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;   // 已经走出这个 provider 块
      const m = lines[j].match(row);
      if (m) {
        lines[j] = m[1] + JSON.stringify(String(value || "")) + m[2];
        fs.writeFileSync(CONFIG_YAML, lines.join(eol), "utf8");
        return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

// 切换当前服务：改 chat.provider 那一行
function setActiveProviderInConfig(name) {
  try {
    const src = fs.readFileSync(CONFIG_YAML, "utf8");
    const eol = src.includes("\r\n") ? "\r\n" : "\n";
    const lines = src.split(/\r?\n/);
    const i = lines.findIndex((l) => /^\s+provider:\s*\S/.test(l));
    if (i < 0) return false;
    lines[i] = lines[i].replace(/^(\s*provider:\s*)\S+/, "$1" + name);
    fs.writeFileSync(CONFIG_YAML, lines.join(eol), "utf8");
    return true;
  } catch (e) { return false; }
}

/* ---- 模型列表：从服务商官方接口拉 ----
   两家都是 OpenAI 兼容的 GET /models。返回里混着 embedding / 语音 / 画图 / 审核等
   根本不能对话的条目（OpenAI 一次能返 124 个），这里两道过滤：
     1) NON_CHAT_MODEL —— 滤掉压根不能对话的
     2) MODEL_MIN_VERSION —— 按版本下限只留新系列（OpenAI 老版本太多，全列出来没法看）*/
const NON_CHAT_MODEL = /(embed|whisper|tts|audio|speech|voice|dall-?e|image|sora|vision-encoder|moderation|transcrib|rerank|similarity|search|realtime|davinci|babbage|curie|ada-)/i;

// 服务名 → 只保留 gpt-<主>.<次> 不低于这个版本的模型。没列进来的服务不做版本过滤。
const MODEL_MIN_VERSION = { openai: [5, 6] };   // 只留 gpt-5.6 系列及更新的

// 从 "gpt-5.6-luna" 里取出 [5, 6]；取不到（o3 / chat-latest / sora-2 这类）返回 null
function gptVersionOf(id) {
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(String(id));
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
}
// 逐段比大小，不能用 parseFloat —— 那样 "5.10" 会被当成 5.1 而小于 5.6
function versionAtLeast(v, min) {
  return v[0] !== min[0] ? v[0] > min[0] : v[1] >= min[1];
}

async function listModelsFromProvider(name, key) {
  const base = String(getProviderField(name, "base_url") || "").replace(/\/+$/, "");
  const label = PROVIDER_LABELS[name] || name;
  if (!base) return { error: "config.yaml 里没配 " + label + " 的 base_url" };
  if (!key) return { error: "先填好 " + label + " 的 Key，再点 ↻ 拉取模型列表" };
  try {
    const res = await fetch(base + "/models", {
      headers: { "Authorization": "Bearer " + key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: "HTTP " + res.status + "：" + t.slice(0, 120) };
    }
    const data = await res.json();
    const all = (data.data || []).map((m) => m && m.id).filter(Boolean);
    const min = MODEL_MIN_VERSION[name];
    const models = all.filter((id) => {
      if (NON_CHAT_MODEL.test(id)) return false;
      if (!min) return true;                       // 这家不做版本过滤
      const v = gptVersionOf(id);
      return v ? versionAtLeast(v, min) : false;   // 认不出版本的一律不要
    }).sort();
    console.log("[models] " + name + " 返回 " + all.length + " 个，过滤后 " + models.length + " 个");
    return { models, total: all.length };
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "连接超时（15 秒）" : e.message;
    return { error: msg };
  }
}

// 把当前服务同步进 opencode 配置（~/.config/opencode/opencode.json），
// 这样你只填一次 key、选一次模型，agent 干活(opencode)也直接能用。
function syncOpencodeConfig() {
  try {
    const p = getActiveProvider();
    if (!p.model) { console.log("[opencode] 还没选模型，跳过同步"); return false; }
    // DeepSeek 的 OpenAI 兼容路径要带 /v1；OpenAI 的 base_url 本身已经带了
    const baseURL = p.name === "deepseek" ? "https://api.deepseek.com/v1" : p.base_url;

    const dir = path.join(require("os").homedir(), ".config", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, "opencode.json");
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { cfg = {}; }
    }
    cfg["$schema"] = cfg["$schema"] || "https://opencode.ai/config.json";
    cfg.provider = cfg.provider || {};
    const options = { apiKey: p.api_key, baseURL };
    if (p.name === "deepseek") options.setCacheKey = true;
    cfg.provider[p.name] = {
      npm: "@ai-sdk/openai-compatible",
      options,
      models: { [p.model]: { name: p.model } },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
    console.log("[opencode] 已同步 " + p.name + "/" + p.model);
    return true;
  } catch (e) {
    console.log("[opencode] 写配置失败：" + e.message);
    return false;
  }
}
/* ============================================================
   快捷键设置：存在 userData 下的 shortcuts.json（外壳配置，不动 config.yaml）
   ============================================================ */
const SHORTCUTS_PATH = path.join(app.getPath("userData"), "shortcuts.json");
const DEFAULT_SHORTCUTS = { translate: "Ctrl+Q", ocr: "Ctrl+Alt+Q" };

function getShortcuts() {
  try {
    const raw = fs.readFileSync(SHORTCUTS_PATH, "utf8");
    const obj = JSON.parse(raw);
    return {
      translate: obj.translate || DEFAULT_SHORTCUTS.translate,
      ocr: obj.ocr || DEFAULT_SHORTCUTS.ocr,
    };
  } catch (e) {
    return { ...DEFAULT_SHORTCUTS };
  }
}

function saveShortcuts(sc) {
  try {
    fs.writeFileSync(SHORTCUTS_PATH, JSON.stringify(sc, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}

// 把界面用的加速键（如 "Ctrl+Alt+Q"）注册到全局。返回是否全部成功。
function registerShortcuts() {
  const sc = getShortcuts();
  // 先注销上次注册的两个（保留 Alt+Space 聊天键，它单独注册）
  if (prevRegistered.translate) { try { globalShortcut.unregister(prevRegistered.translate); } catch (e) {} }
  if (prevRegistered.ocr) { try { globalShortcut.unregister(prevRegistered.ocr); } catch (e) {} }
  let ok = true;
  let tOk = false, oOk = false;
  try { tOk = globalShortcut.register(sc.translate, doTranslate); if (!tOk) ok = false; } catch (e) { ok = false; }
  try { oOk = globalShortcut.register(sc.ocr, doOCR); if (!oOk) ok = false; } catch (e) { ok = false; }
  prevRegistered = { translate: sc.translate, ocr: sc.ocr };
  console.log(`[shortcuts] 翻译=${sc.translate}(${tOk?"OK":"失败"}) 识图=${sc.ocr}(${oOk?"OK":"失败"})`);
  return ok;
}
let prevRegistered = { translate: "", ocr: "" };

// 录制快捷键时：临时注销全局快捷键，否则按键会被全局热键抢走，传不到输入框
ipcMain.on("shortcuts-pause", () => {
  if (prevRegistered.translate) { try { globalShortcut.unregister(prevRegistered.translate); } catch (e) {} }
  if (prevRegistered.ocr) { try { globalShortcut.unregister(prevRegistered.ocr); } catch (e) {} }
  try { globalShortcut.unregister("Alt+Space"); } catch (e) {}
});
ipcMain.on("shortcuts-resume", () => {
  registerShortcuts();
  try { globalShortcut.register("Alt+Space", toggleChat); } catch (e) {}
});

ipcMain.on("settings-get-shortcuts", (e) => { e.returnValue = getShortcuts(); });
ipcMain.on("settings-save-shortcuts", (e, sc) => {
  // 校验并尝试注册；失败则回滚
  const old = getShortcuts();
  const next = {
    translate: (sc && sc.translate) ? String(sc.translate).trim() : DEFAULT_SHORTCUTS.translate,
    ocr: (sc && sc.ocr) ? String(sc.ocr).trim() : DEFAULT_SHORTCUTS.ocr,
  };
  saveShortcuts(next);
  const ok = registerShortcuts();
  if (!ok) {
    // 注册失败（快捷键被占用/非法）→ 回滚
    saveShortcuts(old);
    registerShortcuts();
    e.returnValue = { ok: false };
    return;
  }
  e.returnValue = { ok: true };
});

// 设置窗要的全部模型配置：当前选了谁 + 每家已存的 key 和模型
// （一次性都给渲染层，下拉切换时本地就能换，不用再走 IPC）
ipcMain.on("settings-get-model-config", (e) => {
  const chat = readConfig().chat || {};
  const names = Object.keys(chat.providers || {});
  e.returnValue = {
    provider: chat.provider || names[0] || "",
    providers: names.map((n) => ({
      name: n,
      label: PROVIDER_LABELS[n] || n,
      key: getProviderField(n, "api_key"),
      model: getProviderField(n, "model"),
    })),
  };
});
// 拉模型列表：用渲染层当前框里的 key（可能还没保存），这样填完就能立刻拉
ipcMain.handle("settings-list-models", async (_e, payload) => {
  const name = (payload && payload.provider) || "";
  const key = (payload && payload.key) || "";
  if (!name) return { error: "没指定服务" };
  return await listModelsFromProvider(name, key);
});
ipcMain.on("settings-save-model-config", (_e, payload) => {
  const provider = (payload && payload.provider) || "";
  const keys = (payload && payload.keys) || {};
  const models = (payload && payload.models) || {};
  if (!provider) return;
  // 每家的 key 和模型都写回去 —— 不然在设置窗里切来切去改的内容会只存住最后一家
  for (const name of Object.keys(keys)) setProviderFieldInConfig(name, "api_key", keys[name]);
  for (const name of Object.keys(models)) setProviderFieldInConfig(name, "model", models[name]);
  setActiveProviderInConfig(provider);   // 聊天/翻译/识图用（config.yaml）
  syncOpencodeConfig();                  // agent 干活用（opencode.json）
  // 通知后端重载配置（lru_cache 会缓存旧值，不通知就不生效）
  if (ws && wsReady) {
    try { ws.send(JSON.stringify({ type: "reload_config" })); } catch (e) {}
  }
  // 不再保存后自动关窗——否则设置窗里的"✓ 已保存"/"Key 已清空"提示一闪即没，用户看不到。
  // 用户看完提示后自行按 ✕ 或 Esc 关闭。
});
// 工作目录：读写 config.yaml 的 agent.whitelist_dir
function getWorkDirFromConfig() {
  try {
    const yaml = fs.readFileSync(CONFIG_YAML, "utf8");
    const m = yaml.match(/whitelist_dir:\s*["']([^"']+)["']/);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}
function setWorkDirInConfig(dir) {
  try {
    const cfgPath = CONFIG_YAML;
    let yaml = fs.readFileSync(cfgPath, "utf8");
    // Windows 路径的反斜杠在 YAML 双引号里会被当成转义符（\U 等），统一转成正斜杠
    const safeDir = String(dir || "").replace(/\\/g, "/");
    yaml = yaml.replace(/(whitelist_dir:\s*)["'][^"']*["']/, '$1"' + safeDir + '"');
    fs.writeFileSync(cfgPath, yaml, "utf8");
    return true;
  } catch (e) { return false; }
}
ipcMain.on("settings-get-workdir", (e) => { e.returnValue = getWorkDirFromConfig(); });
ipcMain.on("settings-save-workdir", (_e, dir) => {
  setWorkDirInConfig(dir);
  if (ws && wsReady) {
    try { ws.send(JSON.stringify({ type: "reload_config" })); } catch (e) {}
  }
});
ipcMain.handle("settings-browse-dir", async () => {
  // 以设置窗为父窗口打开（模态），并在返回后重新显示/聚焦设置窗，避免它被隐藏
  const parent = (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : undefined;
  const result = await dialog.showOpenDialog(parent, {
    properties: ["openDirectory"],
    title: "选择蛋蛋的工作目录",
  });
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
  }
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.on("settings-close", () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

/* ============================================================
   图片识别（OCR）：截图 → 视觉模型识别文字 → 弹窗显示
   ============================================================ */
let fullScreenDataUrl = null; // 全屏截图暂存

/* ---- 模型调用：识图 / 翻译都走当前选中的那家服务 ----
   OpenCode Go 和 DeepSeek 都是 OpenAI 兼容的 /chat/completions + Bearer，只差 base_url 和 model。
   （聊天不走这里，它在 Python 后端 chat_llm.py，读的是同一份 config.yaml。）*/
function providerEndpoint(p) { return p.base_url + "/chat/completions"; }
function providerHeaders(p) {
  return { "Content-Type": "application/json", "Authorization": "Bearer " + p.api_key };
}
// 取当前服务并检查配齐了没有；缺什么就抛出一句能直接给用户看的话
/* 按当前服务的"参数方言"拼请求体。
   OpenAI 新一代模型（gpt-5.x / o 系列）不认 max_tokens、也不许改 temperature
   （2026-08-22 实测：传 max_tokens / temperature=0 或 0.7 一律 400）；DeepSeek 两个都吃。
   差异只在这一处消化，三个调用点都复用。*/
function buildBody(p, { messages, stream, maxTokens, temperature }) {
  const body = { model: p.model, messages, stream: !!stream };
  if (maxTokens) body[p.maxTokensParam] = maxTokens;
  if (temperature !== undefined && p.supportsTemperature) body.temperature = temperature;
  return JSON.stringify(body);
}

function requireProvider() {
  const p = getActiveProvider();
  const label = PROVIDER_LABELS[p.name] || p.name;
  if (!p.base_url) throw new Error("config.yaml 里没配 " + label + " 的 base_url");
  if (!p.api_key) throw new Error("请先在设置里填入 " + label + " 的 API Key");
  return p;
}

// 识图：把图片和文字一起发给当前服务的多模态模型
async function callVision(messages, maxTokens) {
  const p = requireProvider();
  const res = await fetch(providerEndpoint(p), {
    method: "POST",
    headers: providerHeaders(p),
    body: buildBody(p, { messages, stream: false, maxTokens })
  });
  if (!res.ok) { const t = await res.text(); throw new Error("HTTP " + res.status + ": " + t.slice(0, 200)); }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function createCropWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  cropWin = new BrowserWindow({
    x: workArea.x, y: workArea.y,
    width: workArea.width, height: workArea.height,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  cropWin.loadFile(path.join(__dirname, "renderer", "crop.html"));
  cropWin.setAlwaysOnTop(true, "screen-saver");
  cropWin.setFullScreen(true);
}

ipcMain.on("crop-done", (_e, croppedDataUrl) => {
  if (cropWin && !cropWin.isDestroyed()) {
    cropWin.hide();
  }
  if (croppedDataUrl) showOcrResult(croppedDataUrl);
});

ipcMain.on("crop-cancel", () => {
  if (cropWin && !cropWin.isDestroyed()) cropWin.hide();
});

function createOcrWindow() {
  ocrWin = new BrowserWindow({
    width: 760, height: 640, show: false, frame: false,
    skipTaskbar: false, hasShadow: false,
    transparent: true, resizable: true, minWidth: 500, minHeight: 400,
    title: "图片识别",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  ocrWin.loadFile(path.join(__dirname, "renderer", "ocr.html"));
  // 关闭只隐藏，不销毁 —— 保证下次截图能重新打开；点窗外也不会关
  ocrWin.on("close", (e) => {
    if (!appQuitting) { e.preventDefault(); ocrWin.hide(); }
  });
}

async function doOCR() {
  try {
    const { desktopCapturer } = require("electron");
    const d = screen.getPrimaryDisplay();
    // 按物理像素抓图（逻辑尺寸 × 缩放系数）：高 DPI 屏上截图不发虚，OCR 识别率更高
    const sf = d.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(d.size.width * sf),
        height: Math.round(d.size.height * sf)
      }
    });
    if (!sources.length) return;
    fullScreenDataUrl = sources[0].thumbnail.toDataURL();
    // 裁剪窗口已预建，直接 show + 发送截图
    if (!cropWin || cropWin.isDestroyed()) createCropWindow();
    // 窗口已预建并加载过 HTML → did-finish-load 不会再触发，直接发图片
    // 窗口还在加载中 → 等加载完再发
    const sendImg = () => cropWin.webContents.send("crop-image", fullScreenDataUrl);
    if (cropWin.webContents.isLoading()) {
      cropWin.webContents.once("did-finish-load", sendImg);
    } else {
      sendImg();
    }
    cropWin.show();
    cropWin.focus();
  } catch (e) {
    console.log("[ocr] 截图失败：" + e.message);
  }
}

function showOcrResult(croppedDataUrl) {
  // 窗口在启动时已创建、关闭时只隐藏，这里必定存在；若意外销毁则重建
  if (!ocrWin || ocrWin.isDestroyed()) createOcrWindow();
  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(cursor);
  const b = ocrWin.getBounds();             // 保留用户可能调过的尺寸
  const w = b.width, h = b.height;
  // min 防超出右/下边界，max 防超出左/上边界（光标贴屏幕边缘时窗口不再弹到屏幕外）
  const x = Math.max(d.workArea.x + 10, Math.min(cursor.x + 20, d.workArea.x + d.workArea.width - w - 10));
  const y = Math.max(d.workArea.y + 10, Math.min(Math.round(cursor.y - h / 2), d.workArea.y + d.workArea.height - h - 10));
  ocrWin.setBounds({ x, y, width: w, height: h });

  const sendImg = () => ocrWin.webContents.send("ocr-image", croppedDataUrl);
  if (ocrWin.webContents.isLoading()) {
    ocrWin.webContents.once("did-finish-load", sendImg);
  } else {
    sendImg();
  }
  ocrWin.show();
  ocrWin.focus();

  // 调用 DeepSeek 多模态识别图中文字
  (async () => {
    try {
      const text = await callVision([
        { role: "user", content: [
          { type: "text", text: "请识别这张图片中的所有文字，原样输出。如果图片中没有文字，请说'未识别到文字'。不要添加任何解释或额外内容。" },
          { type: "image_url", image_url: { url: croppedDataUrl } }
        ] }
      ], 2000);
      if (ocrWin && !ocrWin.isDestroyed()) ocrWin.webContents.send("ocr-result", { text, error: "" });
    } catch (e) {
      if (ocrWin && !ocrWin.isDestroyed()) ocrWin.webContents.send("ocr-result", { text: "", error: "识别失败：" + e.message });
    }
  })();
}

ipcMain.on("ocr-copy", (_e, text) => { clipboard.writeText(text || ""); });
ipcMain.on("ocr-translate", (_e, text) => {
  // 复制原文到剪贴板，然后触发翻译
  clipboard.writeText(text || "");
  doTranslate();
});
// 翻译结果回显（不开新窗口）
ipcMain.on("ocr-translate-inline", async (_e, text) => {
  try {
    const result = await translateText(text);
    if (ocrWin && !ocrWin.isDestroyed()) {
      ocrWin.webContents.send("ocr-trans-result", result.error ? { text: "", error: result.error } : { text: result.text, error: "" });
    }
  } catch (e) {
    if (ocrWin && !ocrWin.isDestroyed()) ocrWin.webContents.send("ocr-trans-result", { text: "", error: "翻译失败：" + e.message });
  }
});
// 聊天：对图中内容提问
ipcMain.on("ocr-chat", async (_e, { imageData, ocrText, question }) => {
  try {
    const messages = [
      { role: "system", content: "你是一个图片内容助手。用户会给你一张图片和已识别的文字，你可以回答关于图片内容的问题。回答简洁、直接。" },
      { role: "user", content: [
        { type: "text", text: "以下是图片中已识别的文字：\n" + (ocrText || "（无文字）") + "\n\n用户的问题：" + question },
        { type: "image_url", image_url: { url: imageData } }
      ] }
    ];
    const answer = await callVision(messages, 1000);
    if (ocrWin && !ocrWin.isDestroyed()) ocrWin.webContents.send("ocr-chat-result", { text: answer, error: "" });
  } catch (e) {
    if (ocrWin && !ocrWin.isDestroyed()) ocrWin.webContents.send("ocr-chat-result", { text: "", error: "回答失败：" + e.message });
  }
});
ipcMain.on("ocr-close", () => { if (ocrWin && !ocrWin.isDestroyed()) ocrWin.hide(); });

/* ---- 渲染层 → 主进程 ---- */
// （穿透切换已改为主进程 hitTest 轮询，不再需要渲染层上报）
ipcMain.on("send-text", (_e, text) => { sendText(String(text || "")); });
// 通用透传：confirm_result / interrupt / set_mode 等控制消息直接发给后端
ipcMain.on("send-raw", (_e, obj) => {
  if (!obj || typeof obj !== "object") return;
  // 用户对"闲置询问"选了"否"：不清，重置闲置计时（不发给后端）
  if (obj.type === "clear_decline") {
    lastChatActivity = Date.now();
    idlePromptShown = false;
    return;
  }
  if (ws && wsReady) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
    // 用户在聊天窗切换模式 → 记住这次选择（下次启动/重连自动恢复）
    if (obj.type === "set_mode" && obj.mode) saveMode(obj.mode);
    // 清空对话（手动 or 闲置询问选是）→ 标记上下文已空、重置闲置计时
    if (obj.type === "clear_context") {
      contextEmpty = true;
      lastChatActivity = Date.now();
      idlePromptShown = false;
    }
  }
});
ipcMain.on("open-chat", () => openChat());
ipcMain.on("open-settings", () => openSettings());
ipcMain.on("hide-chat", () => { if (chatWin) chatWin.hide(); });
// 翻译浮窗：复制译文 / 关闭
ipcMain.on("trans-copy", (_e, text) => { clipboard.writeText(text || ""); });
ipcMain.on("trans-close", () => { if (transWin && !transWin.isDestroyed()) transWin.close(); });

/* ============================================================
   划词翻译（复用蛋蛋当前选中的模型服务，体验与原翻译小软件一致）
   ============================================================ */
const TRANS_W = 380;
const TRANS_H_MAX_RATIO = 1 / 6;
let transShortText = false; // 本次译文是否短文本（短文本才"点窗外/失焦即关"）

function detectLang(text) {
  const cn = (text.match(/[一-鿿]/g) || []).length;
  const en = (text.match(/[a-zA-Z]/g) || []).length;
  if (cn > en) return "zh";
  if (en > cn) return "en";
  if (cn === 0 && en === 0) return "other";
  return cn >= en ? "zh" : "en";
}

async function translateText(text) {
  const lang = detectLang(text);
  if (lang === "other") return { error: "仅支持中英互译" };
  try {
    const prov = requireProvider();
    const result = await fetch(providerEndpoint(prov), {
      method: "POST",
      headers: providerHeaders(prov),
      body: buildBody(prov, {
        messages: [
          { role: "system", content:
            "You are a professional Chinese-English translator. Translate the user's text accurately and naturally.\n\n" +
            "Rules:\n" +
            "- If the input is Chinese, translate to English. If English, translate to Chinese.\n" +
            "- Preserve the original paragraph and line-break structure exactly. Do not merge lines.\n" +
            "- Output ONLY the translation. No explanations, no notes, no quotation marks, no preamble.\n" +
            "- Keep terminology precise and the tone natural." },
          { role: "user", content: text }
        ],
        stream: false,
        temperature: 0.7,
      })
    });
    if (!result.ok) {
      const body = await result.text().catch(() => "");
      throw new Error("HTTP " + result.status + " — " + body.slice(0, 120));
    }
    const data = await result.json();
    return { text: data.choices[0].message.content.trim() };
  } catch (e) {
    return { error: "API调用失败：" + e.message };
  }
}

// AI 流式翻译：逐段 send 给翻译窗（打字机效果）
async function aiRefineStream(text, shortText) {
  const send = (ch, payload) => { if (transWin && !transWin.isDestroyed()) transWin.webContents.send(ch, payload); };
  send("trans-ai-start", { shortText: !!shortText });
  const lang = detectLang(text);
  if (lang === "other") { send("trans-ai-done", { error: "仅支持中英互译" }); return; }
  try {
    const prov = requireProvider();
    const res = await fetch(providerEndpoint(prov), {
      method: "POST",
      headers: providerHeaders(prov),
      body: buildBody(prov, {
        messages: [
          { role: "system", content:
            "You are a professional Chinese-English translator. Translate the user's text accurately and naturally.\n\n" +
            "Rules:\n" +
            "- If the input is Chinese, translate to English. If English, translate to Chinese.\n" +
            "- Preserve the original paragraph and line-break structure exactly. Do not merge lines.\n" +
            "- Output ONLY the translation. No explanations, no notes, no quotation marks, no preamble.\n" +
            "- Keep terminology precise and the tone natural, polished and refined." },
          { role: "user", content: text }
        ],
        stream: true,
        temperature: 0.7,
      })
    });
    if (!res.ok) {
      const b = await res.text().catch(() => "");
      send("trans-ai-done", { error: "API调用失败：HTTP " + res.status + " — " + b.slice(0, 120) });
      return;
    }
    // 解析 SSE 流
    let full = "";
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content || "";
          if (delta) { full += delta; send("trans-ai-delta", delta); }
        } catch (e) {}
      }
    }
    send("trans-ai-done", { text: full.trim() });
  } catch (e) {
    send("trans-ai-done", { error: "AI 翻译出错：" + e.message });
  }
}

function createTransWindow() {
  transWin = new BrowserWindow({
    width: TRANS_W, height: 200, show: false, frame: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    transparent: true, resizable: true, minWidth: 260, minHeight: 140,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  transWin.loadFile(path.join(__dirname, "renderer", "trans.html"));
  transWin.on("close", (e) => { if (!appQuitting) { e.preventDefault(); transWin.hide(); } });
  // 短文本译文：点到窗外（窗口失焦）就关掉，符合原翻译小软件的手感。
  // 长文本不自动关（避免正看着长译文时一失焦就没），只能 ✕/Esc 关。
  transWin.on("blur", () => {
    if (transShortText && transWin && !transWin.isDestroyed() && transWin.isVisible()) {
      transWin.hide();
    }
  });
}

// 外层投影留白（对应 WPF Grid Margin=16，四周各 16px）
const TRANS_PAD = 16;

// 判断是否以英文为主（对应 WPF IsMostlyEnglish）
function isMostlyEnglish(text) {
  let letters = 0, total = 0;
  for (const c of text) {
    if (/\s/.test(c)) continue;
    total++;
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) letters++;
  }
  return total > 0 && letters > total / 2;
}

// 完全复刻 WPF EstimateAndSetSize + PlaceWindow：按原文长度定面板尺寸，光标附近弹出
function showTransWindow(original) {
  if (!transWin || transWin.isDestroyed()) createTransWindow();
  const len = original.length;

  // —— 面板宽度分档（对应 EstimateAndSetSize）——
  let panelW;
  if (len <= 20) panelW = 230;
  else if (len <= 80) panelW = 346;
  else if (len <= 200) panelW = 461;
  else panelW = 576;

  // —— 面板高度：约 35 字符一行，每行 24px，+96 内边距，上限 403 ——
  const estLines = Math.ceil(len / 35);
  let panelH = Math.min(estLines * 24 + 96, 403);

  // 英文为主：宽高各 ×0.87
  if (isMostlyEnglish(original)) {
    panelW *= 0.87;
    panelH *= 0.87;
  }

  // 约束：MinWidth=240 MaxWidth=676 MaxHeight=462（对应 XAML）
  panelW = Math.max(230, Math.min(676, panelW));
  panelH = Math.max(120, Math.min(462, panelH));

  // 窗口尺寸 = 面板 + 四周投影留白
  const winW = Math.round(panelW + TRANS_PAD * 2);
  const winH = Math.round(panelH + TRANS_PAD * 2);

  // 给一点范围（min≠max）：固定成 min==max 会让透明窗口在某些情况下不合成上屏
  transWin.setMinimumSize(260, 150);
  transWin.setMaximumSize(760, 520);

  // —— 定位（对应 PlaceWindow）：光标右下方，超界则翻转/贴边 ——
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  let left = cursor.x;
  let top = cursor.y + 20;
  if (left + winW > wa.x + wa.width) left = wa.x + wa.width - winW - 10;
  if (top + winH > wa.y + wa.height) top = cursor.y - winH - 20;
  if (left < wa.x) left = wa.x + 10;
  if (top < wa.y) top = wa.y + 10;

  transWin.setBounds({ x: Math.round(left), y: Math.round(top), width: winW, height: winH });
  // 强制弹到最前（Windows 下后台进程抢焦点受限，用 alwaysOnTop 最高层级 + moveTop）
  transWin.setAlwaysOnTop(true, "screen-saver");
  transWin.show();
  transWin.moveTop();
  transWin.focus();
}

async function doTranslate() {
  // 翻译是浮窗查词，全屏应用时也该能用，不受 fullscreenHidden 限制
  const oldClip = clipboard.readText();
  try {
    // 用 execFile（异步）代替 execSync（同步阻塞主进程最长 2 秒）
    await new Promise((resolve) => {
      execFile("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"
      ], { windowsHide: true, timeout: 2000 }, () => resolve());
    });
  } catch (e) {}
  await new Promise(r => setTimeout(r, 150));
  const selected = clipboard.readText().trim();
  clipboard.writeText(oldClip || "");
  if (!selected) return;
  // 直接用 AI 流式翻译（打字机效果），无 DeepL、无"AI精翻"按钮
  transShortText = selected.length < 100; // 决定是否"失焦即关"（见 transWin 的 blur）
  showTransWindow(selected);
  await aiRefineStream(selected, transShortText);
}

/* ============================================================
   opencode 检测：干活内核，缺了引导用户安装
   ============================================================ */
function checkOpencode() {
  // 有内置版（打包分发）→ 直接用，不用弹任何安装引导
  if (OPENCODE_DIR) {
    console.log("[opencode] 使用内置版本：" + path.join(OPENCODE_DIR, "opencode.exe"));
    return;
  }
  const { execFile } = require("child_process");
  // Windows 上 opencode 是 .cmd/.ps1，用 where 查更可靠
  const cmd = process.platform === "win32" ? "where" : "which";
  execFile(cmd, ["opencode"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    const found = !err && stdout && stdout.trim().length > 0;
    if (found) {
      console.log("[opencode] 已安装：" + stdout.trim().split(/\r?\n/)[0]);
      return;
    }
    console.log("[opencode] 未检测到");
    const r = dialog.showMessageBoxSync({
      type: "info",
      title: "蛋蛋需要 opencode 才能帮你干活",
      message: "没有检测到 opencode（蛋蛋的干活内核）",
      detail:
        "蛋蛋的「聊天」和「翻译」不受影响，可以正常用。\n" +
        "但要让蛋蛋帮你读写文件、跑命令（agent 干活），需要先装 opencode。\n\n" +
        "安装方法（需要先有 Node.js）：\n" +
        "  1. 打开命令行（Win+R 输入 cmd）\n" +
        "  2. 运行：npm i -g opencode-ai\n" +
        "  3. 装好后重启蛋蛋\n\n" +
        "点「复制安装命令」把命令复制到剪贴板。",
      buttons: ["复制安装命令", "知道了"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r === 0) clipboard.writeText("npm i -g opencode-ai");
  });
}

/* ============================================================
   应用生命周期
   ============================================================ */
let appQuitting = false;
/* ============================================================
   系统托盘：启动后在任务栏右下角显示小图标，右键有菜单
   ============================================================ */
// 用代码画一个"蛋蛋"托盘图标（简化版：暖白蛋身 + 深棕描边 + 两只带高光的大眼睛，
// 去掉腮红/蝴蝶结等细节）。32×32 供 Windows 缩放到 16 更清晰。
function makeDandanIcon() {
  const { nativeImage } = require("electron");
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || x >= S || y < 0 || y >= S) return;
    const i = (y * S + x) * 4;
    // Windows 上 createFromBuffer 按 BGRA 排列（写反会变成淡蓝蛋）
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  // 与蛋蛋本体同形（pet.css .egg：border-radius 50%/62% 62% 38% 38%，宽高比 110:130）：
  // 左右全宽不收窄，上半 62% 高圆润穹顶，下半 38% 高。
  const cx = 16, rx = 12.5, eggH = 29.5, topY = 1.25;
  const ryTop = eggH * 0.62, ryBot = eggH * 0.38, cy = topY + ryTop;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const yy = y + 0.5 - cy;
      const dx = (x + 0.5 - cx) / rx;
      const dy = yy / (yy < 0 ? ryTop : ryBot);
      const dist = dx * dx + dy * dy;
      if (dist <= 1) {
        if (dist >= 0.80) {
          // 描边（深一点的米棕）
          put(x, y, 200, 170, 120, 255);
        } else {
          // 蛋身：纯米色平涂，无渐变
          put(x, y, 250, 240, 220, 255);
        }
      }
    }
  }
  // 两只黑色圆眼睛
  const eye = (ex) => {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x + 0.5 - ex) / 2.6;
        const dy = (y + 0.5 - 15) / 2.6;
        if (dx * dx + dy * dy <= 1) put(x, y, 20, 20, 20, 255);
      }
    }
  };
  eye(12); // 左眼
  eye(20); // 右眼
  return nativeImage.createFromBuffer(buf, { width: S, height: S });
}

function createTray() {
  const icon = makeDandanIcon();
  tray = new Tray(icon);
  tray.setToolTip("蛋蛋桌宠");

  const contextMenu = Menu.buildFromTemplate([
    { label: "显示蛋蛋", click: () => {
      if (win && !win.isDestroyed()) {
        if (fullscreenHidden) userOverrodeFullscreen = true; // 全屏时主动显示→暂停自动隐藏
        fullscreenHidden = false;
        win.show();
        win.setAlwaysOnTop(true, "screen-saver");
      }
    }},
    { label: "隐藏蛋蛋", click: () => { if (win && !win.isDestroyed()) win.hide(); } },
    { type: "separator" },
    { label: "聊天 (Alt+Space)", click: () => openChat() },
    { label: "设置", click: () => openSettings() },
    { type: "separator" },
    { label: "退出蛋蛋", click: () => quitApp() },
  ]);
  tray.setContextMenu(contextMenu);

  // 双击托盘图标 → 显示/隐藏（也支持全屏时主动显示）
  tray.on("double-click", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.hide();
    else {
      if (fullscreenHidden) userOverrodeFullscreen = true;
      fullscreenHidden = false;
      win.show(); win.setAlwaysOnTop(true, "screen-saver");
    }
  });
}

function quitApp() { console.log("[app] 用户点了退出（托盘/右键菜单）"); appQuitting = true; app.quit(); }

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    createWindow();
    createChatWindow();
    createTransWindow();
    createOcrWindow();
    createCropWindow();
    createTray();
    startBackend();
    connectWS();
    const spOk = globalShortcut.register("Alt+Space", toggleChat);
    console.log(`[shortcuts] 聊天 Alt+Space(${spOk ? "OK" : "失败：可能被别的程序占用，可用托盘/双击开聊天"})`);
    registerShortcuts();   // 翻译 / 识图 快捷键（可在设置里改）
    checkOpencode();   // 检测 opencode，缺了就引导安装
  });
  app.on("second-instance", () => {
    // 再次启动（如误双击启动脚本）→ 显示蛋蛋，但遵循全屏检测
    if (win && !win.isDestroyed() && !fullscreenHidden) win.show();
  });
  app.on("before-quit", () => { appQuitting = true; });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopBackend();
    if (fsProc) { try { fsProc.kill(); } catch (e) {} fsProc = null; } // 收掉全屏观察进程
    if (ws) { try { ws.close(); } catch (e) {} }
    if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
  });
  // 蛋蛋是常驻应用：关闭聊天窗不退出，只有右键"退出蛋蛋"才退
  app.on("window-all-closed", () => {});
}

/* ============================================================
   蛋蛋桌宠 · 预加载脚本 (preload.js)
   用 contextBridge 只暴露最小的安全接口给渲染层。
   ============================================================ */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  // 主进程通知：开始/结束"走两步"
  onWalkStart: (cb) => ipcRenderer.on("walk-start", (_e, dir) => cb(dir)),
  onWalkEnd: (cb) => ipcRenderer.on("walk-end", () => cb()),
  // 手动拖动蛋蛋（不用系统原生拖动，避免透明窗口拖动时消失）；坐标用 screenX/screenY
  petDragStart: (sx, sy) => ipcRenderer.send("pet-drag-start", sx, sy),
  petDragMove: (sx, sy) => ipcRenderer.send("pet-drag-move", sx, sy),
  petDragEnd: () => ipcRenderer.send("pet-drag-end"),
  // 右键蛋蛋弹菜单
  showPetMenu: () => ipcRenderer.send("show-pet-menu"),

  // 聊天：发消息给后端、监听后端事件、开/关聊天窗
  sendText: (t) => ipcRenderer.send("send-text", t),
  // 控制消息透传（confirm_result / interrupt / set_mode / stt_start / stt_stop）
  sendRaw: (obj) => ipcRenderer.send("send-raw", obj),
  // 蛋蛋头顶气泡（聊天窗关着时的消息展示）
  onPetBubble: (cb) => ipcRenderer.on("pet-bubble", (_e, text) => cb(text)),
  // 翻译浮窗
  onTransResult: (cb) => ipcRenderer.on("trans-result", (_e, data) => cb(data)),
  transCopy: (text) => ipcRenderer.send("trans-copy", text),
  transClose: () => ipcRenderer.send("trans-close"),
  onTransAiStart: (cb) => ipcRenderer.on("trans-ai-start", (_e, data) => cb(data)),
  onTransAiDelta: (cb) => ipcRenderer.on("trans-ai-delta", (_e, chunk) => cb(chunk)),
  onTransAiDone: (cb) => ipcRenderer.on("trans-ai-done", (_e, data) => cb(data)),
  // 设置窗
  settingsGetModelConfig: () => ipcRenderer.sendSync("settings-get-model-config"),
  settingsSaveModelConfig: (cfg) => ipcRenderer.send("settings-save-model-config", cfg),
  settingsListModels: (p) => ipcRenderer.invoke("settings-list-models", p),
  settingsGetWorkDir: () => ipcRenderer.sendSync("settings-get-workdir"),
  settingsSaveWorkDir: (dir) => ipcRenderer.send("settings-save-workdir", dir),
  settingsGetShortcuts: () => ipcRenderer.sendSync("settings-get-shortcuts"),
  settingsSaveShortcuts: (sc) => ipcRenderer.sendSync("settings-save-shortcuts", sc),
  shortcutsPause: () => ipcRenderer.send("shortcuts-pause"),
  shortcutsResume: () => ipcRenderer.send("shortcuts-resume"),
  settingsBrowseDir: () => ipcRenderer.invoke("settings-browse-dir"),
  settingsClose: () => ipcRenderer.send("settings-close"),
  // 每次打开设置窗，主进程通知渲染层把表单刷新回已保存的状态
  onSettingsRefresh: (cb) => ipcRenderer.on("settings-refresh", () => cb()),
  // 图片识别
  onOcrImage: (cb) => ipcRenderer.on("ocr-image", (_e, dataUrl) => cb(dataUrl)),
  onOcrResult: (cb) => ipcRenderer.on("ocr-result", (_e, data) => cb(data)),
  ocrCopy: (text) => ipcRenderer.send("ocr-copy", text),
  ocrTranslate: (text) => ipcRenderer.send("ocr-translate", text),
  // 翻译结果回显（不开新窗口）
  ocrTranslateInline: (text) => ipcRenderer.send("ocr-translate-inline", text),
  onOcrTransResult: (cb) => ipcRenderer.on("ocr-trans-result", (_e, data) => cb(data)),
  // 聊天：对图中内容提问
  ocrChat: (imageData, ocrText, question) => ipcRenderer.send("ocr-chat", { imageData, ocrText, question }),
  onOcrChatResult: (cb) => ipcRenderer.on("ocr-chat-result", (_e, data) => cb(data)),
  ocrClose: () => ipcRenderer.send("ocr-close"),
  // 截图区域选择
  onCropImage: (cb) => ipcRenderer.on("crop-image", (_e, dataUrl) => cb(dataUrl)),
  cropDone: (croppedDataUrl) => ipcRenderer.send("crop-done", croppedDataUrl),
  cropCancel: () => ipcRenderer.send("crop-cancel"),
  onAiEvent: (cb) => ipcRenderer.on("ai-event", (_e, payload) => cb(payload)),
  openChat: () => ipcRenderer.send("open-chat"),
  openSettings: () => ipcRenderer.send("open-settings"),
  hideChat: () => ipcRenderer.send("hide-chat"),
});

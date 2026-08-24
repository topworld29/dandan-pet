/* ============================================================
   设置窗 逻辑 (settings.js)
   选大模型服务 + 该服务的 API Key + 模型（模型列表从服务商官方接口拉）
   全部写进后端 config.yaml
   ============================================================ */
(function () {
  "use strict";

  const providerBtn = document.getElementById("providerBtn");
  const providerLabel = document.getElementById("providerLabel");
  const providerList = document.getElementById("providerList");
  const keyInput = document.getElementById("keyInput");
  const keyClear = document.getElementById("keyClear");
  const modelInput = document.getElementById("modelInput");
  const modelList = document.getElementById("modelList");
  const modelRefresh = document.getElementById("modelRefresh");
  const modelHint = document.getElementById("modelHint");
  const workDir = document.getElementById("workDir");
  const browseBtn = document.getElementById("browseBtn");
  const saveBtn = document.getElementById("saveBtn");
  const closeBtn = document.getElementById("closeBtn");
  const status = document.getElementById("status");
  const scTranslate = document.getElementById("scTranslate");
  const scOcr = document.getElementById("scOcr");
  const scTranslateReset = document.getElementById("scTranslateReset");
  const scOcrReset = document.getElementById("scOcrReset");

  // 快捷键的初始默认值
  const DEFAULT_TRANSLATE = "Ctrl+Q";
  const DEFAULT_OCR = "Ctrl+Alt+Q";

  // 每家服务已存的 key / 模型：{ 服务名: 值 }。下拉切换时就地取用，不用再走 IPC；
  // 保存时整份送回主进程，所以在窗里切来切去改的内容都不会丢。
  let keyMap = {};
  let modelMap = {};
  let lastProvider = "";
  // 服务清单 [{name,label}] 和当前选中的服务名（原来靠 <select> 存，现在自己存）
  let providers = [];
  let currentProvider = "";
  // 最近一次拉到的模型列表（下拉面板的数据源）
  let allModels = [];

  function setStatus(msg, cls) {
    status.textContent = msg;
    status.className = "settings__status " + (cls || "");
  }

  function syncStatus() {
    const k = (keyInput.value || "").trim();
    setStatus(k ? "已配置" : "未配置 Key", k ? "ok" : "");
  }

  function setHint(msg, cls) {
    modelHint.textContent = msg;
    modelHint.className = "settings__note " + (cls || "");
  }

  // 把当前框里的内容记回 map（切换服务/保存前都要先做，否则改动会丢）
  function stashCurrent() {
    if (!lastProvider) return;
    keyMap[lastProvider] = keyInput.value.trim();
    modelMap[lastProvider] = modelInput.value.trim();
  }

  /* ---- 模型下拉面板 ----
     没用 <datalist>：它的弹层由 Chromium 画，高度和滚动都控制不了，条目一多就没法翻。
     改成自己渲染一个 max-height + overflow-y:auto 的列表，滚轮就能上下翻。*/
  function renderModelList(filter) {
    const kw = (filter || "").trim().toLowerCase();
    const shown = kw ? allModels.filter((id) => id.toLowerCase().includes(kw)) : allModels;
    modelList.innerHTML = "";
    if (!shown.length) {
      const div = document.createElement("div");
      div.className = "settings__modellist__empty";
      div.textContent = allModels.length ? "没有匹配的模型" : "还没拉到模型列表";
      modelList.appendChild(div);
      return;
    }
    const current = modelInput.value.trim();
    for (const id of shown) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings__modelitem" + (id === current ? " is-current" : "");
      const nameEl = document.createElement("span");
      nameEl.textContent = id;
      btn.appendChild(nameEl);
      if (id === current) {
        const tick = document.createElement("span");
        tick.className = "settings__dropitem__tick";
        tick.textContent = "✓";
        btn.appendChild(tick);
      }
      btn.addEventListener("click", () => {
        modelInput.value = id;
        hideModelList();
      });
      modelList.appendChild(btn);
    }
  }
  function showModelList() {
    if (!allModels.length) return;
    renderModelList("");
    modelList.hidden = false;
    // 让当前选中的那条滚到可见位置
    const cur = modelList.querySelector(".is-current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function hideModelList() { modelList.hidden = true; }

  /* ---- 模型列表：调服务商官方的 GET /models ----
     拉不到就保持输入框里已有的值不动（输入框本身可以手打），只在提示行说明原因。*/
  async function fetchModels() {
    const provider = currentProvider;
    const key = keyInput.value.trim();
    if (!provider) return;
    setHint("正在拉取 " + labelOf(provider) + " 的模型列表…", "");
    modelRefresh.disabled = true;
    try {
      const res = await window.petAPI.settingsListModels({ provider, key });
      if (res && res.models && res.models.length) {
        allModels = res.models;
        showModelList();
        const filtered = (res.total || res.models.length) - res.models.length;
        setHint("共 " + res.models.length + " 个可选模型"
          + (filtered > 0 ? "（官方返回 " + res.total + " 个，已滤掉 " + filtered + " 个）" : "")
          + "。点输入框可重新展开，列表内可滚轮翻动。", "ok");
      } else if (res && res.models) {
        allModels = [];
        hideModelList();
        setHint("官方返回了空列表，可以直接在框里手打模型名。", "");
      } else {
        allModels = [];
        hideModelList();
        setHint("拉取失败：" + ((res && res.error) || "未知原因") + "。可以直接在框里手打模型名。", "err");
      }
    } catch (e) {
      allModels = [];
      hideModelList();
      setHint("拉取失败：" + e.message + "。可以直接在框里手打模型名。", "err");
    } finally {
      modelRefresh.disabled = false;
    }
  }

  function labelOf(name) {
    const p = providers.find((x) => x.name === name);
    return p ? p.label : name;
  }

  /* ---- 服务下拉（自绘）---- */
  function renderProviderList() {
    providerList.innerHTML = "";
    for (const p of providers) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings__dropitem" + (p.name === currentProvider ? " is-current" : "");
      const name = document.createElement("span");
      name.textContent = p.label;
      btn.appendChild(name);
      if (p.name === currentProvider) {
        const tick = document.createElement("span");
        tick.className = "settings__dropitem__tick";
        tick.textContent = "✓";
        btn.appendChild(tick);
      }
      btn.addEventListener("click", () => { selectProvider(p.name); hideProviderList(); });
      providerList.appendChild(btn);
    }
  }
  function showProviderList() {
    if (!providers.length) return;
    renderProviderList();
    providerList.hidden = false;
  }
  function hideProviderList() { providerList.hidden = true; }

  // 切换服务：先把当前框里的内容记进 map，再把新服务已存的填进来，然后重拉模型列表
  function selectProvider(name) {
    if (name === currentProvider) return;
    stashCurrent();
    currentProvider = name;
    lastProvider = name;
    providerLabel.textContent = labelOf(name);
    keyInput.value = keyMap[name] || "";
    modelInput.value = modelMap[name] || "";
    allModels = [];
    hideModelList();
    syncStatus();
    setHint("", "");
    if (keyInput.value) fetchModels();
    else setHint("填好 Key 后点 ↻ 拉取模型列表。", "");
  }

  // 从后端已保存的配置刷新整个表单。每次打开设置窗都会调用一次，
  // 这样上次没保存就关掉的改动会被丢弃——只有按"保存"的改动才算数。
  function loadFromConfig() {
    const mc = window.petAPI.settingsGetModelConfig() || { provider: "", providers: [] };
    keyMap = {};
    modelMap = {};
    providers = mc.providers.map((p) => ({ name: p.name, label: p.label }));
    for (const p of mc.providers) {
      keyMap[p.name] = p.key || "";
      modelMap[p.name] = p.model || "";
    }
    currentProvider = mc.provider;
    providerLabel.textContent = labelOf(mc.provider);
    hideProviderList();
    lastProvider = mc.provider;
    keyInput.value = keyMap[mc.provider] || "";
    modelInput.value = modelMap[mc.provider] || "";
    allModels = [];
    hideModelList();
    syncStatus();
    setHint("", "");
    workDir.value = window.petAPI.settingsGetWorkDir() || "";
    const sc = window.petAPI.settingsGetShortcuts() || {};
    scTranslate.value = sc.translate || DEFAULT_TRANSLATE;
    scOcr.value = sc.ocr || DEFAULT_OCR;
    if (keyInput.value) fetchModels();
  }
  loadFromConfig();
  // 主进程每次显示设置窗时会发来 settings-refresh，让表单回到已保存状态
  if (window.petAPI.onSettingsRefresh) window.petAPI.onSettingsRefresh(loadFromConfig);

  // 把 keydown 事件转成 Electron 加速键字符串（如 "Ctrl+Alt+Q"）
  function eventToAccelerator(e) {
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    // 主键：字母/数字/功能键，忽略单独的修饰键
    let key = e.key;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null; // 只按了修饰键，还没按主键
    if (key === " ") key = "Space";
    else if (key.length === 1) key = key.toUpperCase();
    else if (/^F\d{1,2}$/.test(key)) key = key; // F1~F12
    else if (key === "ArrowUp") key = "Up";
    else if (key === "ArrowDown") key = "Down";
    else if (key === "ArrowLeft") key = "Left";
    else if (key === "ArrowRight") key = "Right";
    // 其它特殊键直接用原名（Enter/Tab/等），Electron 多数支持
    if (mods.length === 0) return null; // 要求至少一个修饰键，避免误触
    return mods.concat(key).join("+");
  }

  // 给一个快捷键输入框绑定录制逻辑
  function bindShortcutInput(input) {
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();   // 阻止冒泡到 document（否则 Esc 会连带关掉设置窗）
      if (e.key === "Escape") {
        // 录制中按 Esc：取消录制，恢复更改前的按键（blur 里会把提示文字换回原值）
        input.value = "请按下快捷键…";
        input.blur();
        return;
      }
      const acc = eventToAccelerator(e);
      if (acc) {
        input.value = acc;
        input.blur();
      }
    });
    input.addEventListener("focus", () => {
      input.classList.add("recording");
      input.value = "请按下快捷键…";
      window.petAPI.shortcutsPause();   // 暂停全局热键，否则按键被抢走录不到
    });
    input.addEventListener("blur", () => {
      input.classList.remove("recording");
      // 若失焦时还是提示文字（没录到），恢复原值
      if (input.value === "请按下快捷键…") {
        const sc = window.petAPI.settingsGetShortcuts() || {};
        input.value = input === scTranslate ? (sc.translate || DEFAULT_TRANSLATE) : (sc.ocr || DEFAULT_OCR);
      }
      window.petAPI.shortcutsResume(); // 恢复全局热键
    });
  }
  bindShortcutInput(scTranslate);
  bindShortcutInput(scOcr);

  providerBtn.addEventListener("click", () => {
    if (providerList.hidden) showProviderList(); else hideProviderList();
  });
  keyInput.addEventListener("input", syncStatus);
  modelRefresh.addEventListener("click", fetchModels);

  // 模型输入框：点一下展开列表；边打字边筛；点别处/按 Esc 收起
  modelInput.addEventListener("focus", showModelList);
  modelInput.addEventListener("click", showModelList);
  modelInput.addEventListener("input", () => {
    if (!allModels.length) return;
    modelList.hidden = false;
    renderModelList(modelInput.value);
  });
  document.addEventListener("mousedown", (e) => {
    if (!(e.target === modelInput || modelList.contains(e.target))) hideModelList();
    if (!(providerBtn.contains(e.target) || providerList.contains(e.target))) hideProviderList();
  });

  // Key 输入框的清除小叉号：清空当前已填内容（保存时才写入生效）
  keyClear.addEventListener("click", () => { keyInput.value = ""; keyInput.focus(); syncStatus(); });

  // 快捷键"恢复默认"：把对应输入框恢复成初始默认值（保存时才生效）
  scTranslateReset.addEventListener("click", () => { scTranslate.value = DEFAULT_TRANSLATE; });
  scOcrReset.addEventListener("click", () => { scOcr.value = DEFAULT_OCR; });

  // 浏览文件夹
  browseBtn.addEventListener("click", async () => {
    const dir = await window.petAPI.settingsBrowseDir();
    if (dir) workDir.value = dir;
  });

  saveBtn.addEventListener("click", () => {
    const key = keyInput.value.trim();
    const model = modelInput.value.trim();
    // 先存快捷键（可能失败：被占用/非法）
    const scRes = window.petAPI.settingsSaveShortcuts({
      translate: scTranslate.value.trim(),
      ocr: scOcr.value.trim(),
    });
    if (scRes && scRes.ok === false) {
      setStatus("✗ 快捷键无法注册（可能被其它程序占用），请换一个", "err");
      return;
    }
    // 空 Key 也照存——代表"清空"，后端会热重载后停用聊天（填回再保存即可恢复）
    stashCurrent();
    window.petAPI.settingsSaveModelConfig({
      provider: currentProvider, keys: keyMap, models: modelMap,
    });
    window.petAPI.settingsSaveWorkDir(workDir.value.trim());
    const label = labelOf(currentProvider);
    if (!key) setStatus("✓ 已保存（" + label + " 的 Key 已清空，蛋蛋暂时无法聊天，填回 Key 保存即可恢复）", "err");
    else if (!model) setStatus("✓ 已保存（还没选模型，聊天/翻译/识图/干活都会报错，选一个再保存）", "err");
    else setStatus("✓ 已保存（" + label + " · " + model + "）", "ok");
  });

  closeBtn.addEventListener("click", () => window.petAPI.settingsClose());
  document.addEventListener("keydown", (e) => {
    // 列表展开时，Esc 先收列表，不关窗
    if (e.key === "Escape" && !modelList.hidden) { hideModelList(); return; }
    if (e.key === "Escape" && !providerList.hidden) { hideProviderList(); return; }
    if (e.key === "Escape") window.petAPI.settingsClose();
  });
})();

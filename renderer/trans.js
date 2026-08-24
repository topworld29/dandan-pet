/* ============================================================
   翻译浮窗 逻辑 (trans.js)
   - 接收主进程发来的 AI 翻译结果（流式打字机）
   - 复制（带抖动反馈）、关闭
   - 点窗外关闭：< 100 字符可点窗外关，≥ 100 字符只能 ✕/Esc 关
   ============================================================ */
(function () {
  "use strict";

  const body = document.getElementById("body");
  const copyBtn = document.getElementById("copyBtn");
  const closeBtn = document.getElementById("closeBtn");
  const trans = document.getElementById("trans");

  let currentText = "";
  let shortText = true;

  // 一次性结果（错误提示 / 非流式）
  window.petAPI.onTransResult((data) => {
    if (data.error) {
      body.textContent = data.error;
      body.classList.add("error");
      currentText = "";
    } else {
      body.textContent = data.translated;
      body.classList.remove("error");
      currentText = data.translated;
    }
    shortText = data.shortText;
    bindOutside();
  });

  // 流式：开始（显示"翻译中…"占位）
  window.petAPI.onTransAiStart((data) => {
    body.textContent = "翻译中…";
    body.classList.remove("error");
    currentText = "";
    shortText = data && data.shortText;
    bindOutside();
  });

  // 流式：逐段追加
  window.petAPI.onTransAiDelta((chunk) => {
    if (body.textContent === "翻译中…") body.textContent = "";
    body.textContent += chunk;
    currentText = body.textContent;
  });

  // 流式：结束
  window.petAPI.onTransAiDone((data) => {
    if (data && data.error) {
      body.textContent = data.error;
      body.classList.add("error");
      currentText = "";
    } else if (data && data.text) {
      body.textContent = data.text;
      currentText = data.text;
    }
  });

  function bindOutside() {
    if (shortText) document.addEventListener("mousedown", onOutsideClick);
    else document.removeEventListener("mousedown", onOutsideClick);
  }

  // 复制成功提示：黑色方框 + 黑色勾（纯黑白，非彩色 emoji）
  const CHECK_SVG =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" style="vertical-align:-2px">' +
    '<rect x="1.5" y="1.5" width="13" height="13" rx="2.5" ' +
    'stroke="#1a1a1a" stroke-width="1.5"/>' +
    '<path d="M4.5 8.2l2.3 2.3 4.7-4.9" stroke="#1a1a1a" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // 复制（带抖动反馈）
  copyBtn.addEventListener("click", () => {
    if (!currentText) return;
    window.petAPI.transCopy(currentText);
    copyBtn.innerHTML = CHECK_SVG;
    playShake();
    setTimeout(() => { copyBtn.textContent = "复制"; }, 1800);
  });

  // 复制成功抖动：快速水平左右摆动（对应 WPF PlayCopyShake 300ms）
  function playShake() {
    trans.animate([
      { transform: "translateX(0)" },
      { transform: "translateX(-4px)" },
      { transform: "translateX(4px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(3px)" },
      { transform: "translateX(0)" },
    ], { duration: 300, easing: "linear" });
  }

  closeBtn.addEventListener("click", () => window.petAPI.transClose());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.petAPI.transClose();
  });

  function onOutsideClick(e) {
    if (!trans.contains(e.target)) window.petAPI.transClose();
  }
})();

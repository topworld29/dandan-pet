/* ============================================================
   图片识别窗 逻辑 (ocr.js)
   - 识别结果显示 + 复制原文
   - 翻译结果显示（原地，不开新窗口）+ 复制译文
   - 聊天框：对图中内容提问，调用 AI 解答
   ============================================================ */
(function () {
  "use strict";

  const preview = document.getElementById("preview");
  const textArea = document.getElementById("textArea");
  const copyBtn = document.getElementById("copyBtn");
  const transBtn = document.getElementById("transBtn");
  const transArea = document.getElementById("transArea");
  const transText = document.getElementById("transText");
  const copyTransBtn = document.getElementById("copyTransBtn");
  const chatInput = document.getElementById("chatInput");
  const chatBtn = document.getElementById("chatBtn");
  const chatLog = document.getElementById("chatLog");
  const closeBtn = document.getElementById("closeBtn");

  let currentText = "";
  let currentImageData = ""; // 图片 dataURL，供聊天时发给 AI

  // 接收截图
  window.petAPI.onOcrImage((dataUrl) => {
    currentImageData = dataUrl;
    preview.src = dataUrl;
    textArea.textContent = "识别中…";
    textArea.classList.remove("error");
    currentText = "";
    transArea.hidden = true;
    transText.textContent = "";
    chatLog.innerHTML = "";
  });

  // 接收识别结果
  window.petAPI.onOcrResult((data) => {
    if (data.error) {
      textArea.textContent = data.error;
      textArea.classList.add("error");
      currentText = "";
    } else {
      textArea.textContent = data.text;
      textArea.classList.remove("error");
      currentText = data.text;
    }
  });

  // 复制原文
  copyBtn.addEventListener("click", () => {
    if (currentText) {
      window.petAPI.ocrCopy(currentText);
      copyBtn.textContent = "已复制";
      setTimeout(() => { copyBtn.textContent = "复制原文"; }, 1500);
    }
  });

  // 翻译（调用主进程翻译，结果回来后显示在原窗口）
  transBtn.addEventListener("click", () => {
    if (!currentText) return;
    transBtn.disabled = true;
    transBtn.textContent = "翻译中…";
    transText.textContent = "";
    transArea.hidden = false;
    window.petAPI.ocrTranslateInline(currentText);
  });

  // 接收翻译结果
  window.petAPI.onOcrTransResult((data) => {
    transBtn.disabled = false;
    transBtn.textContent = "翻译";
    if (data.error) {
      transText.textContent = data.error;
    } else {
      transText.textContent = data.text;
    }
  });

  // 复制译文
  copyTransBtn.addEventListener("click", () => {
    const t = transText.textContent;
    if (t) {
      window.petAPI.ocrCopy(t);
      copyTransBtn.textContent = "已复制";
      setTimeout(() => { copyTransBtn.textContent = "复制译文"; }, 1500);
    }
  });

  // 聊天：对图中内容提问
  function sendQuestion() {
    const q = chatInput.value.trim();
    if (!q) return;
    chatInput.value = "";

    // 显示问题
    const qEl = document.createElement("div");
    qEl.className = "chat-msg chat-msg--q";
    qEl.textContent = q;
    chatLog.appendChild(qEl);

    // 显示加载
    const aEl = document.createElement("div");
    aEl.className = "chat-msg chat-msg--loading";
    aEl.textContent = "思考中…";
    chatLog.appendChild(aEl);
    chatLog.scrollTop = chatLog.scrollHeight;

    pendingAnswers.push(aEl);  // 按提问顺序排队，回答按序对应
    window.petAPI.ocrChat(currentImageData, currentText, q);
  }

  // 回答按 FIFO 对应到各自的加载气泡（监听器只注册一次，避免旧问题被覆盖）
  const pendingAnswers = [];
  window.petAPI.onOcrChatResult((data) => {
    const aEl = pendingAnswers.shift();
    if (!aEl) return;
    aEl.className = "chat-msg chat-msg--a";
    aEl.textContent = data.error || data.text;
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  chatBtn.addEventListener("click", sendQuestion);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendQuestion(); }
  });

  // 关闭
  closeBtn.addEventListener("click", () => window.petAPI.ocrClose());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.petAPI.ocrClose();
  });
})();

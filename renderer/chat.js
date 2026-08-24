/* ============================================================
   蛋蛋聊天窗 逻辑 (chat.js)
   阶段 2：聊天（reply / conn）
   阶段 3：干活——移植旧 ChatWindow.cs 的 agent 交互：
     confirm(风险确认，带按钮气泡) / exec_start / exec_progress(进度行) /
     中断按钮 / 严格模式勾选(set_mode) / mode 同步 / user_echo(语音回显)
   ============================================================ */
(function () {
  "use strict";

  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const closeBtn = document.getElementById("closeBtn");
  const conn = document.getElementById("conn");
  const modeSelect = document.getElementById("modeSelect");
  const muteBtn = document.getElementById("muteBtn");
  const clearBtn = document.getElementById("clearBtn");
  const runState = document.getElementById("runState");
  const stopBtn = document.getElementById("stopBtn");

  let thinking = null;          // "蛋蛋想想…"占位气泡
  let suppressModeEvent = false; // 同步 mode 时别再回发 set_mode（防回环）

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function addBubble(role, text, extraClass) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg--" + role + (extraClass ? " " + extraClass : "");
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    wrap.appendChild(b);
    log.appendChild(wrap);
    // 气泡太多时裁掉最旧的：长期挂机不清空对话，DOM 也不会无限膨胀拖慢窗口
    while (log.children.length > 300) log.removeChild(log.firstChild);
    scrollDown();
    return wrap;
  }

  function clearThinking(text) {
    if (thinking) {
      thinking.classList.remove("thinking");
      if (text != null) thinking.querySelector(".bubble").textContent = text;
      else thinking.remove();
      thinking = null;
      return true;
    }
    return false;
  }

  // 等回复时也显示停止按钮（但不显示"干活中"那行标签）
  function setWaiting(on) {
    stopBtn.hidden = !on;
    if (on) runState.hidden = true;
  }
  function setRunning(on) {
    runState.hidden = !on;
    stopBtn.hidden = !on;
  }

  /* ---- 发送 ---- */
  function send() {
    const t = input.value.trim();
    if (!t) return;
    // 检查 WS 连接状态
    if (conn.textContent !== "已连接") {
      addBubble("ai", "⚠️ 还没连上蛋蛋的大脑，请稍等或检查后端是否运行中。", "sys");
      return;
    }
    input.value = "";
    input.style.height = "39px";
    addBubble("user", t);
    thinking = addBubble("ai", "蛋蛋想想…");
    thinking.classList.add("thinking");
    setWaiting(true);   // 思考时显示停止按钮
    window.petAPI.sendText(t);
  }
  // 输入框随内容长高（单行 39px ~ 最高 120px）
  function autoGrow() {
    input.style.height = "39px";
    const h = Math.min(120, input.scrollHeight);
    input.style.height = h + "px";
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  closeBtn.addEventListener("click", () => window.petAPI.hideChat());

  /* ---- 🎤 点击语音输入：点一下开始，不说话自动停 / 再点手动停 ---- */
  const micBtn = document.getElementById("micBtn");
  let recording = false;
  function micStart() {
    if (recording) return;
    recording = true;
    micBtn.classList.add("recording");
    micBtn.title = "点击停止";
    window.petAPI.sendRaw({ type: "stt_start" });
  }
  function micStop(sendStop) {
    if (!recording) return;
    recording = false;
    micBtn.classList.remove("recording");
    micBtn.title = "点击语音输入";
    if (sendStop) window.petAPI.sendRaw({ type: "stt_stop" });
  }
  micBtn.addEventListener("click", () => {
    if (recording) micStop(true);   // 手动停：发 stt_stop
    else micStart();
  });

  /* ---- 停止：打断干活/思考中的回复 ---- */
  stopBtn.addEventListener("click", () => {
    window.petAPI.sendRaw({ type: "interrupt" });
    setRunning(false);
    setWaiting(false);
    // 思考中的占位气泡直接撤掉
    if (thinking) { thinking.remove(); thinking = null; }
    addBubble("ai", "（已停止）", "sys");
  });
  modeSelect.addEventListener("change", () => {
    if (suppressModeEvent) return;
    window.petAPI.sendRaw({ type: "set_mode", mode: modeSelect.value });
  });

  /* ---- 清空对话：清后端上下文 + 清界面气泡 ---- */
  clearBtn.addEventListener("click", () => {
    window.petAPI.sendRaw({ type: "clear_context" });
    log.innerHTML = "";
    addBubble("ai", "对话已清空，我们重新开始聊吧~", "sys");
  });

  /* ---- 静音：持久开关。开=蛋蛋不再朗读；点一下切回来 ---- */
  let muted = false;
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    window.petAPI.sendRaw({ type: "set_mute", muted });
    if (muted) {
      window.petAPI.sendRaw({ type: "mute" }); // 立刻停掉当前正在念的
      muteBtn.classList.add("muted");
      muteBtn.textContent = "🔇";
      muteBtn.title = "点一下恢复朗读";
    } else {
      muteBtn.classList.remove("muted");
      muteBtn.textContent = "🔊";
      muteBtn.title = "让蛋蛋闭嘴（停止朗读）";
    }
  });

  /* ---- 确认气泡（同意 / 先不做）---- */
  function showConfirm(id, text) {
    clearThinking(null); // 确认请求本身就是"想完了"的结果
    const wrap = addBubble("ai", text);
    const bubble = wrap.querySelector(".bubble");
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const okBtn = document.createElement("button");
    okBtn.className = "ok"; okBtn.textContent = "✅ 让蛋蛋做";
    const noBtn = document.createElement("button");
    noBtn.className = "no"; noBtn.textContent = "先不做";
    actions.appendChild(okBtn); actions.appendChild(noBtn);
    bubble.appendChild(actions);
    scrollDown();

    function answer(ok) {
      okBtn.disabled = true; noBtn.disabled = true;
      window.petAPI.sendRaw({ type: "confirm_result", id, ok });
      if (ok) { thinking = addBubble("ai", "蛋蛋准备开工…"); thinking.classList.add("thinking"); }
    }
    okBtn.addEventListener("click", () => answer(true));
    noBtn.addEventListener("click", () => answer(false));
  }

  /* ---- 闲置询问气泡：是否清空对话 ---- */
  function showClearPrompt() {
    const wrap = addBubble("ai", "主人好久没跟蛋蛋说话啦~ 需要清空这次的对话，重新开始吗？");
    const bubble = wrap.querySelector(".bubble");
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const okBtn = document.createElement("button");
    okBtn.className = "ok"; okBtn.textContent = "是，清空";
    const noBtn = document.createElement("button");
    noBtn.className = "no"; noBtn.textContent = "不用";
    actions.appendChild(okBtn); actions.appendChild(noBtn);
    bubble.appendChild(actions);
    scrollDown();

    okBtn.addEventListener("click", () => {
      okBtn.disabled = true; noBtn.disabled = true;
      window.petAPI.sendRaw({ type: "clear_context" });
      log.innerHTML = "";
      addBubble("ai", "对话已清空，我们重新开始聊吧~", "sys");
    });
    noBtn.addEventListener("click", () => {
      okBtn.disabled = true; noBtn.disabled = true;
      window.petAPI.sendRaw({ type: "clear_decline" });
      addBubble("ai", "好的，那蛋蛋继续陪着主人~", "sys");
      scrollDown();
    });
  }

  /* ---- 接收后端事件 ---- */
  window.petAPI.onAiEvent((p) => {
    if (p.kind === "conn") {
      conn.textContent = p.ok ? "已连接" : "未连接";
      conn.className = "conn " + (p.ok ? "ok" : "no");
      if (!p.ok) setRunning(false);
      return;
    }
    if (p.kind !== "ai") return;
    const m = p.msg;

    switch (m.type) {
      case "reply":
        setRunning(false);
        if (!clearThinking(m.text)) addBubble("ai", m.text);
        scrollDown();
        break;

      case "confirm":
        showConfirm(m.id, m.text);
        break;

      case "clear_prompt":  // 闲置很久，蛋蛋问是否清空对话
        showClearPrompt();
        break;

      case "context_compacted":  // 上下文过长已自动压缩
        addBubble("ai", m.text || "（对话有点长啦，蛋蛋把前面的内容整理压缩了一下，我们继续~）", "sys");
        scrollDown();
        break;

      case "exec_start":
        setRunning(true);
        if (thinking) thinking.querySelector(".bubble").textContent = "蛋蛋开工啦 🔧";
        break;

      case "exec_progress":
        addBubble("ai", m.text, "prog");
        break;

      case "mode":
        suppressModeEvent = true;
        var mv = m.mode === "plan" ? "plan" : "build"; // 旧值一律归为 build
        modeSelect.value = mv;
        suppressModeEvent = false;
        break;

      case "need_workdir": // 没配工作目录：清掉思考气泡，引导去设置
        setRunning(false); setWaiting(false);
        if (thinking) { thinking.remove(); thinking = null; }
        window.petAPI.openSettings();
        break;

      case "stt_text": // 语音转文字：填进输入框，用户确认后再发
        micStop(false);
        if (m.text) {
          input.value = (input.value ? input.value + " " : "") + m.text;
          input.focus();
          autoGrow();
        } else {
          // 没听清：轻提示，不打扰
          input.placeholder = "没太听清，再说一遍…";
          setTimeout(() => { input.placeholder = "和蛋蛋说点什么…"; }, 2500);
        }
        break;

      case "stt_auto_stop": // 后端因静音自动停止了录音，复位麦克风图标
        micStop(false);
        break;
    }
  });

  input.focus();
})();

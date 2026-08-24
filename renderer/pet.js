/* ============================================================
   蛋蛋桌宠 · 渲染层逻辑 (pet.js)
   - 拖动：手动（mousedown/mousemove → IPC → 主进程 setBounds）。
     不用 -webkit-app-region:drag——透明窗口原生拖动有概率拖完不重绘→"消失"。
   - 穿透切换：由主进程轮询系统光标做命中检测，渲染层不参与。
   - 双击：打开聊天窗；右键：contextmenu → IPC → 主进程弹菜单。
   - 行为动画：眨眼（随机）、走路摇摆（配合主进程移动窗口）。
   ============================================================ */
(function () {
  "use strict";

  const pet = document.getElementById("pet");

  // 双击蛋蛋 → 打开聊天窗
  pet.addEventListener("dblclick", () => window.petAPI.openChat());

  // 手动拖动：按住蛋蛋 → 主进程随鼠标事件实时移动窗口（跟手不卡）。
  // 取代 -webkit-app-region:drag（透明窗口用原生拖动有概率拖完不重绘→"消失"）。
  pet.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;              // 只响应左键
    e.preventDefault();
    window.petAPI.petDragStart(e.screenX, e.screenY);
    function onMove(ev) { window.petAPI.petDragMove(ev.screenX, ev.screenY); }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.petAPI.petDragEnd();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // 右键蛋蛋 → 弹出小菜单（原生拖动区已移除，改由渲染层上报）
  pet.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.petAPI.showPetMenu();
  });

  /* ---- 眨眼：随机间隔，偶尔连眨两下 ---- */
  function blink() {
    pet.classList.add("blinking");
    setTimeout(() => pet.classList.remove("blinking"), 130);
    if (Math.random() < 0.28) {
      setTimeout(() => {
        pet.classList.add("blinking");
        setTimeout(() => pet.classList.remove("blinking"), 120);
      }, 250);
    }
  }
  function scheduleBlink() {
    setTimeout(() => { blink(); scheduleBlink(); }, 2200 + Math.random() * 4200);
  }
  scheduleBlink();

  /* ---- 走两步：主进程移动窗口，这里配合左右摇摆动画 ---- */
  if (window.petAPI.onWalkStart) {
    window.petAPI.onWalkStart(() => pet.classList.add("walking"));
    window.petAPI.onWalkEnd(() => pet.classList.remove("walking"));
  }

  /* ---- 蛋蛋回话时张嘴说几秒 ---- */
  let talkTimer = null;
  if (window.petAPI.onAiEvent) {
    window.petAPI.onAiEvent((p) => {
      if (p.kind === "ai" && p.msg && p.msg.type === "reply") {
        pet.classList.add("talking");
        if (talkTimer) clearTimeout(talkTimer);
        talkTimer = setTimeout(() => pet.classList.remove("talking"), 2500);
      }
    });
  }

  /* ---- 头顶气泡：聊天窗关着时展示消息，10 秒后消失 ---- */
  const bubble = document.getElementById("bubble");
  let bubbleTimer = null;
  if (window.petAPI.onPetBubble) {
    window.petAPI.onPetBubble((text) => {
      bubble.textContent = text;
      bubble.hidden = false;
      if (bubbleTimer) clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 10000);
    });
  }

  /* ---- 情绪：随机切换不同情绪表情，只是表现，不需解决 ---- */
  const MOODS = ["angry", "happy", "pitiful", "tired", "sad", "excited", "cute"];
  let curMood = null;

  function setMood(mood) {
    if (curMood) pet.classList.remove("mood-" + curMood);
    curMood = mood;
    if (mood) pet.classList.add("mood-" + mood);
  }

  function scheduleMood() {
    // 一段情绪持续 4~9 秒，然后回归平静 8~20 秒，再随机来一个
    const moodDur = 4000 + Math.random() * 5000;
    const calmDur = 8000 + Math.random() * 12000;
    const next = MOODS[Math.floor(Math.random() * MOODS.length)];
    setMood(next);
    setTimeout(() => {
      setMood(null);                       // 回归平静
      setTimeout(scheduleMood, calmDur);
    }, moodDur);
  }

  /* ---- 演示模式：每 3 秒轮播一种情绪（评估表情用，平时关闭）---- */
  const DEMO_MODE = false;
  if (DEMO_MODE) {
    let i = 0;
    setMood(MOODS[0]);
    setInterval(() => {
      i = (i + 1) % MOODS.length;
      setMood(MOODS[i]);
    }, 3000);
  } else {
    // 随机模式：启动后先平静一会儿再随机出现情绪
    setTimeout(scheduleMood, 5000 + Math.random() * 5000);
  }
})();

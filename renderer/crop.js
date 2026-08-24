/* ============================================================
   截图区域选择 逻辑 (crop.js)
   1. 接收全屏截图，作为 canvas 背景（半透明遮罩）
   2. 用户按住拖动画框
   3. 松开后裁剪选中区域，发送回主进程
   ============================================================ */
(function () {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const hint = document.getElementById("hint");

  let img = null;
  let imgScaleX = 1, imgScaleY = 1; // 画布坐标 → 原图像素 的缩放比
  let startX = 0, startY = 0;
  let endX = 0, endY = 0;
  let drawing = false;
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    if (img) {
      imgScaleX = img.naturalWidth / canvas.width;
      imgScaleY = img.naturalHeight / canvas.height;
    }
    redraw();
  }
  window.addEventListener("resize", resize);

  window.petAPI.onCropImage((dataUrl) => {
    const i = new Image();
    i.onload = () => {
      img = i;
      // 清除上次的框选状态，显示新截图
      startX = startY = endX = endY = 0;
      drawing = false;
      hint.style.display = "";
      resize();
    };
    i.src = dataUrl;
  });

  function redraw() {
    if (!img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 绘制截图（半透明遮罩效果）
    ctx.globalAlpha = 0.4;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1.0;

    if (drawing || (endX !== startX && endY !== startY)) {
      const x = Math.min(startX, endX) * dpr;
      const y = Math.min(startY, endY) * dpr;
      const w = Math.abs(endX - startX) * dpr;
      const h = Math.abs(endY - startY) * dpr;

      // 清除选中区域的遮罩（显示原图）
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      // 选框边框
      ctx.strokeStyle = "#f7a0b8";
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // 尺寸提示
      const realW = Math.round(w / dpr);
      const realH = Math.round(h / dpr);
      if (realW > 10 && realH > 10) {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.font = `${13 * dpr}px "Nunito", sans-serif`;
        const label = `${realW} × ${realH}`;
        const metrics = ctx.measureText(label);
        const lx = x + (w - metrics.width) / 2;
        const ly = y + h + 20 * dpr;
        ctx.fillText(label, lx, ly);
      }
    }
  }

  canvas.addEventListener("mousedown", (e) => {
    drawing = true;
    startX = e.clientX;
    startY = e.clientY;
    endX = e.clientX;
    endY = e.clientY;
    hint.style.display = "none";
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!drawing) return;
    endX = e.clientX;
    endY = e.clientY;
    redraw();
  });

  canvas.addEventListener("mouseup", () => {
    if (!drawing) return;
    drawing = false;
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);
    if (w < 10 || h < 10) { window.petAPI.cropCancel(); return; } // 太小（多半是误点）→ 直接取消，关掉遮罩

    // 裁剪：用原图像素坐标（不是画布坐标）
    const cropCanvas = document.createElement("canvas");
    const srcX = Math.round(x * dpr * imgScaleX);
    const srcY = Math.round(y * dpr * imgScaleY);
    const srcW = Math.round(w * dpr * imgScaleX);
    const srcH = Math.round(h * dpr * imgScaleY);
    cropCanvas.width = srcW;
    cropCanvas.height = srcH;
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    const cropped = cropCanvas.toDataURL("image/png");
    window.petAPI.cropDone(cropped);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.petAPI.cropCancel();
  });
})();

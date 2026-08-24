"""
主动触发引擎（阶段 3 ②）：让毛毛主动开口。

  · C 监测类：久坐/很久没理它 → 主动打招呼
  · A 时间类：整点报时（可选，默认关）
  · D 事件类：监测白名单沙箱出现新文件 → 主动提醒
  · E 任务汇报：任务跑完的回报已在 server 的正常回复里完成

实现：
  · apscheduler(AsyncIOScheduler) 跑定时检查（与 FastAPI 同一事件循环）
  · watchdog 监测沙箱目录（独立线程，用 run_coroutine_threadsafe 回推）
  · 所有主动消息用 broadcast 推给前端（type=reply，让桌宠冒泡）
"""

import asyncio
import os
import random
import time
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

_IDLE_LINES = [
    "主人~蛋蛋有点想你了，在忙吗？ (๑• . •๑)",
    "主人主人，蛋蛋乖乖在这儿陪着你哦~",
    "好久没听到主人说话啦，蛋蛋在等你呢 (｡･ω･｡)",
    "主人记得歇一会儿眼睛哦，蛋蛋会一直在的~",
]


class Proactive:
    def __init__(self, loop, broadcast, sandbox_dir: str, cfg: dict):
        self.loop = loop
        self.broadcast = broadcast            # async func(obj)
        self.sandbox_dir = sandbox_dir
        self.cfg = cfg
        self.last_activity = time.time()
        self.last_idle_push = 0.0
        self.suppress_files_until = 0.0       # 任务自己建的文件不报，靠这个窗口屏蔽
        self.scheduler = None
        self.observer = None

    # ---- 外部调用 ----

    def note_activity(self):
        self.last_activity = time.time()

    def suppress_files(self, seconds: float):
        self.suppress_files_until = time.time() + seconds

    def start(self):
        if not self.cfg.get("enabled", True):
            return
        self.scheduler = AsyncIOScheduler(event_loop=self.loop)
        self.scheduler.add_job(self._idle_check, "interval", seconds=20)
        if self.cfg.get("hourly_chime", False):
            self.scheduler.add_job(self._chime, "cron", minute=0)
        self.scheduler.start()

        if self.cfg.get("watch_sandbox", True) and os.path.isdir(self.sandbox_dir):
            handler = _NewFileHandler(self)
            self.observer = Observer()
            self.observer.schedule(handler, self.sandbox_dir, recursive=False)
            self.observer.start()

    def stop(self):
        try:
            if self.scheduler:
                self.scheduler.shutdown(wait=False)
        except Exception:
            pass
        try:
            if self.observer:
                self.observer.stop()
        except Exception:
            pass

    # ---- 定时任务 ----

    async def _idle_check(self):
        thr = self.cfg.get("idle_reminder_seconds", 90)
        now = time.time()
        # 久坐：超过阈值没动静，且自上次活动以来还没主动打过招呼
        if now - self.last_activity >= thr and self.last_idle_push < self.last_activity:
            self.last_idle_push = now
            print(f"[{datetime.now():%H:%M:%S}] 主动：久坐提醒已推送", flush=True)
            await self.broadcast({"type": "reply", "text": random.choice(_IDLE_LINES)})

    async def _chime(self):
        h = datetime.now().hour
        await self.broadcast({"type": "reply", "text": f"主人，现在是 {h} 点啦，记得照顾好自己哦~"})

    # ---- 文件监测（从 watchdog 线程回调） ----

    def on_new_file(self, path: str):
        if time.time() < self.suppress_files_until:
            return  # 任务刚建的文件，不重复提醒
        name = os.path.basename(path)
        coro = self.broadcast(
            {"type": "reply", "text": f"咦？主人，蛋蛋发现沙箱里多了个新文件「{name}」哦~"}
        )
        try:
            asyncio.run_coroutine_threadsafe(coro, self.loop)
        except Exception:
            pass


class _NewFileHandler(FileSystemEventHandler):
    def __init__(self, outer: Proactive):
        self.outer = outer

    def on_created(self, event):
        if not event.is_directory:
            self.outer.on_new_file(event.src_path)

"""
毛毛桌宠 —— Python 后端服务（阶段 2c：流式执行 + 可中断）

WebSocket /ws 消息协议：
  前端→后端：
    {"text": "..."}                      用户消息（闲聊或干活）
    {"type": "confirm_result","id","ok"}  风险任务确认结果
    {"type": "interrupt"}                 中断当前正在跑的任务
  后端→前端：
    {"type": "reply","text"}             最终回复
    {"type": "confirm","id","text"}      请求确认风险任务
    {"type": "exec_start"}               任务开始执行（前端可显示执行面板）
    {"type": "exec_progress","text"}     执行过程的一行（正在做什么）
"""

import asyncio
import json
import subprocess
import sys
from datetime import datetime
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from agent_runner import (
    AgentError,
    build_command,
    friendly_progress,
    result_text,
)
from chat_llm import ChatError, chat, reset_history, did_compact
from config import get_agent, get_proactive, reload_config
from permission import needs_confirm
from config import get_voice
from proactive import Proactive
from router import route
from tts import speak as tts_speak
import tts
import stt

# Windows 控制台默认 GBK，回复里的颜文字/emoji 会让 print 崩溃，进而拖垮连接。
# 把日志输出强制为 UTF-8，编不出的字符用替代符，绝不抛异常。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

app = FastAPI(title="毛毛桌宠后端", version="0.3.0")

# 运行时权限模式覆盖（None 表示用 config.yaml 里的默认）+ 静音开关
_runtime = {"mode": None, "muted": False}

# 活动连接集合 + 主动触发引擎
_clients: set[WebSocket] = set()
_proactive: Proactive | None = None


# 两种模式（对应 opencode 内置 agent）：
#   build 构建模式：可读写文件、跑命令，全自动干活
#   plan  计划模式：只读，只给分析/计划，不改文件
_VALID_MODES = {"build", "plan"}


def current_mode() -> str:
    m = _runtime["mode"] or get_agent().get("mode", "build")
    # 兼容旧值
    if m in ("strict", "default", "auto", "acceptEdits", "bc"):
        return "build"
    return m if m in _VALID_MODES else "build"


async def _broadcast(obj: dict) -> None:
    """把一条消息推给所有活动连接（用于主动触发）。"""
    for ws in list(_clients):
        try:
            await ws.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:
            _clients.discard(ws)
    # 主动提醒只冒气泡，不念语音（用户要求 2026-07-04）


@app.on_event("startup")
async def _on_startup():
    global _proactive
    try:
        sandbox = get_agent().get("whitelist_dir", "")
        _proactive = Proactive(asyncio.get_event_loop(), _broadcast, sandbox, get_proactive())
        _proactive.start()
        print(f"[{_now()}] 主动触发引擎已启动", flush=True)
    except Exception as e:
        print(f"[{_now()}] 主动触发启动失败：{e}", flush=True)


@app.on_event("shutdown")
async def _on_shutdown():
    if _proactive:
        _proactive.stop()


def _now() -> str:
    return f"{datetime.now():%H:%M:%S}"


def _kill_tree(proc) -> None:
    """杀掉子进程及其整棵进程树。
    claude 是 claude.cmd 批处理外壳，底下会再起 node 进程，
    只 kill 外壳杀不掉真正干活的 node，必须连子孙一起杀。"""
    if proc is None or proc.returncode is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
            )
        else:
            proc.kill()
    except Exception:
        pass


@app.get("/health")
async def health():
    return {"status": "ok", "service": "maomao-backend", "time": datetime.now().isoformat()}


# ---------- 发送辅助 ----------

async def _send(ws: WebSocket, obj: dict) -> None:
    await ws.send_text(json.dumps(obj, ensure_ascii=False))


async def _send_reply(ws: WebSocket, text: str) -> None:
    await _send(ws, {"type": "reply", "text": text})
    if not _runtime["muted"]:
        tts_speak(text)  # 同时把回复念出来（异步，未启用/静音则跳过）


# ---------- 任务流式执行 ----------

async def _run_task_streaming(ws: WebSocket, task_text: str, state: dict) -> str | None:
    """
    用 asyncio 子进程流式跑 Claude Code，边跑边推进度。
    返回最终结果文本；若被中断返回 None。
    """
    cmd, workdir, timeout = build_command(task_text, current_mode())

    # 任务自己在沙箱里建的文件不要被"新文件提醒"重复播报
    if _proactive:
        _proactive.suppress_files(timeout + 15)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=workdir,
        # stdin 必须接 DEVNULL：不接管的话 opencode 会继承本进程的 stdin
        # （被 Electron 用管道拉起时是根永不关闭的管道），它会当成"管道喂任务"
        # 一直等 EOF → 零输出直到超时。stderr 只写不读也会涨满管道卡死，同样丢弃。
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=2 ** 24,  # 放大行缓冲，stream-json 的 hook 行可能很长
    )
    state["proc"] = proc
    await _send(ws, {"type": "exec_start"})

    final: str | None = None
    try:
        while True:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
            except asyncio.TimeoutError:
                _kill_tree(proc)
                await _send(ws, {"type": "exec_progress", "text": "⏱ 任务超时，已停止"})
                break
            if not line:
                break
            try:
                event = json.loads(line.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue

            for prog in friendly_progress(event):
                await _send(ws, {"type": "exec_progress", "text": prog})

            r = result_text(event)
            if r is not None:
                final = r

        await proc.wait()
    finally:
        state["proc"] = None
        if _proactive:
            _proactive.suppress_files(8)  # 任务结束后再宽限几秒，盖住延迟的文件事件

    # 被中断（kill 后 returncode 非 0 且没拿到结果）
    if state.get("interrupted"):
        state["interrupted"] = False
        return None

    return final


# ---------- 处理一条用户消息 ----------

async def _handle_user_text(ws: WebSocket, user_text: str, state: dict) -> None:
    try:
        state["cancel_reply"] = False  # 新消息开始，清掉上一次的打断标记
        intent = await asyncio.to_thread(route, user_text)
        print(f"[{_now()}] 收到：{user_text!r} → 路由：{intent}", flush=True)

        if intent != "task":
            reply = await asyncio.to_thread(chat, user_text)
            if state.get("cancel_reply"):
                # 用户在等待期间按了停止 → 丢弃这次回复（不显示、不朗读）
                state["cancel_reply"] = False
                print(f"[{_now()}] 回复被用户打断，已丢弃", flush=True)
                return
            # 若本次触发了上下文压缩，先给前端一个提示
            if did_compact():
                print(f"[{_now()}] 上下文超 100k，已摘要压缩", flush=True)
                await _send(ws, {"type": "context_compacted",
                                 "text": "（对话有点长啦，蛋蛋把前面的内容整理压缩了一下，重要的都记得，我们继续~）"})
            await _send_reply(ws, reply)
            return

        # 干活：按模式决定是否先确认
        mode = current_mode()
        if needs_confirm(user_text, mode):
            approved = await _ask_confirm(ws, user_text, state)
            if not approved:
                await _send_reply(ws, "好的，蛋蛋先不动它啦~")
                print(f"[{_now()}] 用户取消任务", flush=True)
                return

        final = await _run_task_streaming(ws, user_text, state)
        if final is None:
            await _send_reply(ws, "好的，蛋蛋停下来啦~（任务已中断）")
            print(f"[{_now()}] 任务被中断", flush=True)
        else:
            await _send_reply(ws, f"蛋蛋帮主人做好啦～\n{final}")
            print(f"[{_now()}] 任务完成", flush=True)
    except (ChatError, AgentError) as e:
        msg = str(e)
        if "__NO_WORKDIR__" in msg:
            # 没配工作目录：发专门事件让前端引导用户去设置
            clean = msg.replace("__NO_WORKDIR__", "")
            await _send(ws, {"type": "need_workdir", "text": clean})
            await _send_reply(ws, clean)
        else:
            await _send_reply(ws, msg)
    except Exception as e:  # 兜底，别让 worker 挂掉
        await _send_reply(ws, f"蛋蛋出了点小状况：{e}")


async def _ask_confirm(ws: WebSocket, task_text: str, state: dict) -> bool:
    """发确认请求，等 reader 把前端的 confirm_result 放进 future。"""
    cid = str(uuid4())
    prompt = f"蛋蛋要执行任务：\n「{task_text}」\n这可能会创建/修改/删除文件，确认让蛋蛋做吗？"
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    state["confirm"] = (cid, fut)
    await _send(ws, {"type": "confirm", "id": cid, "text": prompt})
    print(f"[{_now()}] 等待确认 id={cid}", flush=True)
    try:
        return bool(await fut)
    finally:
        state["confirm"] = None


# ---------- WebSocket 入口：reader + worker ----------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    _clients.add(ws)
    if _proactive:
        _proactive.note_activity()
    print(f"[{_now()}] 客户端已连接", flush=True)
    # 连接时把当前权限模式同步给前端，便于 UI 显示
    await _send(ws, {"type": "mode", "mode": current_mode()})

    state: dict = {"proc": None, "confirm": None, "interrupted": False}
    queue: asyncio.Queue = asyncio.Queue()

    async def reader():
        """只此一处读 socket：分发控制消息(中断/确认)，用户消息进队列。"""
        while True:
            raw = await ws.receive_text()
            if _proactive:
                _proactive.note_activity()  # 任何前端消息都算"主人还在"
            data = None
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                data = None

            mtype = data.get("type") if isinstance(data, dict) else None

            if mtype == "interrupt":
                # 打断：干活任务杀子进程；聊天回复标记丢弃；顺手停朗读
                state["cancel_reply"] = True
                tts.stop()
                proc = state.get("proc")
                if proc and proc.returncode is None:
                    state["interrupted"] = True
                    _kill_tree(proc)
                print(f"[{_now()}] 收到中断指令", flush=True)
                continue

            if mtype == "stt_start":
                if get_voice().get("stt_enabled", False):
                    try:
                        stt.recorder.start()
                        state["stt_finishing"] = False
                        print(f"[{_now()}] 开始录音", flush=True)
                        asyncio.create_task(_watch_silence())
                    except Exception as e:
                        print(f"[{_now()}] 录音启动失败：{e}", flush=True)
                continue

            if mtype == "stt_stop":
                asyncio.create_task(_finish_stt())
                continue

            if mtype == "mute":
                tts.stop()  # 让蛋蛋立刻闭嘴
                print(f"[{_now()}] 停止朗读", flush=True)
                continue

            if mtype == "set_mute":
                _runtime["muted"] = bool(data.get("muted"))
                if _runtime["muted"]:
                    tts.stop()
                print(f"[{_now()}] 静音开关 → {_runtime['muted']}", flush=True)
                continue

            if mtype == "reload_config":
                reload_config()
                print(f"[{_now()}] 配置已重载（前端设置窗修改了 key）", flush=True)
                continue

            if mtype == "set_mode":
                m = data.get("mode")
                new_mode = m if m in _VALID_MODES else "build"
                silent = bool(data.get("silent"))  # 静默切换（如打开聊天框时的自动重置）
                _runtime["mode"] = new_mode
                print(f"[{_now()}] 切换模式 → {new_mode}{'（静默）' if silent else ''}", flush=True)
                # 回发 mode 事件让前端下拉框同步显示
                await _send(ws, {"type": "mode", "mode": new_mode})
                if not silent:
                    labels = {
                        "build": "构建模式（可改文件、跑命令）",
                        "plan": "计划模式（只读，不动文件）",
                    }
                    await _send_reply(ws, f"好的主人，已切换到{labels[new_mode]}~")
                continue

            if mtype == "clear_context":
                # 清空聊天上下文（手动按钮 / 闲置自动触发）
                reset_history()
                silent = bool(data.get("silent"))
                print(f"[{_now()}] 清空对话上下文{'（静默）' if silent else ''}", flush=True)
                await _send(ws, {"type": "context_cleared"})
                continue

            if mtype == "confirm_result":
                conf = state.get("confirm")
                if conf and conf[0] == data.get("id"):
                    _, fut = conf
                    if not fut.done():
                        fut.set_result(bool(data.get("ok")))
                continue

            # 带 type 但没被上面任何分支处理 = 未知控制消息：忽略，别当用户输入喂给大模型
            if isinstance(data, dict) and mtype is not None and "text" not in data:
                print(f"[{_now()}] 忽略未知控制消息 type={mtype!r}", flush=True)
                continue

            # 普通用户消息（{"text": ...} 或非 JSON 的纯文本）
            text = data["text"] if isinstance(data, dict) and "text" in data else raw
            await queue.put(str(text))

    async def worker():
        """逐条处理用户消息。"""
        while True:
            user_text = await queue.get()
            await _handle_user_text(ws, user_text, state)

    async def _watch_silence():
        """录音期间轮询：检测到持续静音就自动停止并识别，并通知前端复位麦克风。
        最多轮询 300 秒（5 分钟），超时自动停止（防止无限循环）。"""
        max_ticks = 300 * 5  # 每 0.2 秒一次，共 5 分钟
        for _ in range(max_ticks):
            await asyncio.sleep(0.2)
            if stt.recorder._stream is None:  # 已被手动停止
                return
            if stt.recorder.silent_done():
                print(f"[{_now()}] 静音自动停止", flush=True)
                await _send(ws, {"type": "stt_auto_stop"})
                await _finish_stt()
                return
        # 超时保护：如果录音超过 5 分钟还没停，自动结束
        print(f"[{_now()}] 录音超时(5分钟)，自动停止", flush=True)
        await _send(ws, {"type": "stt_auto_stop"})
        await _finish_stt()

    async def _finish_stt():
        """停止录音 → 转文字 → 在窗口回显 → 当作用户消息处理。"""
        if state.get("stt_finishing"):
            return  # 防手动停止和静音自动停止重复触发
        state["stt_finishing"] = True
        try:
            wav = await asyncio.to_thread(stt.recorder.stop)
            if not wav:
                return
            text = (await asyncio.to_thread(stt.transcribe, wav) or "").strip()
            print(f"[{_now()}] 语音识别：{text!r}", flush=True)
            if not text:
                await _send(ws, {"type": "stt_text", "text": ""})  # 空：前端提示没听清
                return
            # 语音转文字：填进输入框，由用户确认后再发送（不直接处理）
            await _send(ws, {"type": "stt_text", "text": text})
        except Exception as e:
            print(f"[{_now()}] 语音处理出错：{e}", flush=True)
        finally:
            state["stt_finishing"] = False

    rtask = asyncio.create_task(reader())
    wtask = asyncio.create_task(worker())
    try:
        await asyncio.gather(rtask, wtask)
    except WebSocketDisconnect:
        print(f"[{_now()}] 客户端已断开", flush=True)
    except Exception as e:
        print(f"[{_now()}] 连接异常：{e}", flush=True)
    finally:
        _clients.discard(ws)
        # 清理：取消任务、杀掉可能还在跑的子进程
        for t in (rtask, wtask):
            t.cancel()
        _kill_tree(state.get("proc"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")

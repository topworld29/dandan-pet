"""
干活层：把"干活"任务调度给 opencode 命令行执行（内核 opencode + DeepSeek 模型）。

用 opencode 而非 Claude Code，好处：中国大陆可直接用 DeepSeek 驱动，无需登录 Anthropic。

- build_command() + friendly_progress(): 流式 json 模式，
  由 server.py 用 asyncio 子进程驱动，边跑边把"正在做什么"推给前端，并可中断。
- run_task(): 一次性模式（保留供测试/兜底）
"""

import json
import os
import shutil
import subprocess

from config import get_agent, get_chat_provider

# 干活用哪个 provider/model：跟着设置窗里选的那家服务和那个模型走。
_FALLBACK_MODEL = "deepseek/deepseek-v4-flash-vision-exp"


def opencode_model() -> str:
    """干活用的模型串："<服务名>/<模型名>"。

    服务名（deepseek / openai）与 opencode 内置的 provider id 同名，所以直接拼即可；
    对应的 key 和 baseURL 由 Electron 侧写进 ~/.config/opencode/opencode.json。
    识图用的也是同一个模型 —— 设置窗里只有一个模型下拉。
    """
    try:
        p = get_chat_provider()
        name, model = p.get("name"), p.get("model")
        if name and model:
            return f"{name}/{model}"
    except Exception:
        pass
    return _FALLBACK_MODEL


class AgentError(Exception):
    """干活出错，带一句给用户看的友好提示。"""


def _opencode_path() -> str:
    path = shutil.which("opencode")
    if not path:
        raise AgentError("找不到 opencode 命令行，主人确认装好了吗？")
    return path


def _resolve_agent() -> dict:
    agent = get_agent()
    if not agent.get("enabled", False):
        raise AgentError("干活功能还没开启呢（config.yaml 里 agent.enabled）")
    workdir = agent.get("whitelist_dir", "")
    if not workdir:
        raise AgentError("__NO_WORKDIR__请先在设置里配置蛋蛋的「工作目录」，蛋蛋才能帮你干活哦~")
    if not os.path.isdir(workdir):
        raise AgentError(f"__NO_WORKDIR__设置里的工作目录不存在：{workdir}\n请在设置里重新选一个存在的文件夹~")
    return agent


# ---------- 流式模式（2c） ----------

def build_command(task_text: str, mode: str = "build"):
    """返回 (cmd 列表, 工作目录, 超时秒数)，用于 asyncio 子进程流式执行。

    mode → opencode agent（与 opencode 内置的两个 agent 对应）：
      · build  构建模式：可读写文件、跑命令，全自动干活（--auto 自动批准权限）
      · plan   计划模式：只读，只做分析/给计划，不改你的文件
    """
    agent = _resolve_agent()
    oc_agent = "plan" if mode == "plan" else "build"
    cmd = [
        _opencode_path(), "run",
        "--model", opencode_model(),
        "--agent", oc_agent,
        "--format", "json",
        task_text,
    ]
    if oc_agent == "build":
        cmd.append("--auto")  # 构建模式自动批准权限，不逐步打断
    return cmd, agent["whitelist_dir"], agent.get("timeout_seconds", 180)


# opencode 工具名（小写）→ 中文友好说法
_TOOL_LABELS = {
    "write": "写文件", "edit": "改文件", "read": "读文件",
    "bash": "跑命令", "glob": "查找文件", "grep": "搜索内容", "list": "列目录",
    "webfetch": "抓取网页", "task": "调度子任务", "todowrite": "整理待办",
    "patch": "改文件",
}


def _tool_line(name: str, inp: dict) -> str:
    label = _TOOL_LABELS.get((name or "").lower(), name)
    hint = ""
    if isinstance(inp, dict):
        if "filePath" in inp:
            hint = os.path.basename(str(inp["filePath"]))
        elif "file_path" in inp:
            hint = os.path.basename(str(inp["file_path"]))
        elif "command" in inp:
            hint = str(inp["command"])[:60]
        elif "pattern" in inp:
            hint = str(inp["pattern"])
        elif "query" in inp:
            hint = str(inp["query"])
    return f"🔧 {label} {hint}".strip()


def friendly_progress(event: dict) -> list[str]:
    """把一个 opencode json 事件翻译成给用户看的进度行（可能 0~多条）。"""
    lines: list[str] = []
    etype = event.get("type")
    part = event.get("part", {})
    if etype == "tool_use":
        inp = (part.get("state", {}) or {}).get("input", {})
        lines.append(_tool_line(part.get("tool", ""), inp))
    elif etype == "text":
        txt = (part.get("text") or "").strip()
        if txt:
            lines.append("💬 " + txt)
    return lines


def result_text(event: dict) -> str | None:
    """opencode 没有单独的 result 事件；最终回复就是最后一条 text。
    这里对每条 text 都返回其文本，server.py 会用最后一条覆盖为最终结果。"""
    if event.get("type") == "text":
        txt = (event.get("part", {}).get("text") or "").strip()
        return txt or None
    return None


# ---------- 一次性模式（2a，保留） ----------

def run_task(task_text: str, mode: str = "acceptEdits") -> str:
    """让 opencode 执行一个任务，返回结果文本（阻塞、非流式）。"""
    cmd, workdir, timeout = build_command(task_text, mode)
    try:
        proc = subprocess.run(
            cmd, cwd=workdir, capture_output=True,
            stdin=subprocess.DEVNULL,  # 同 server.py：别让 opencode 继承并傻等我们的 stdin
            text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise AgentError("任务跑太久超时啦，主人可以拆小一点再试~")
    except Exception as e:
        raise AgentError(f"启动 opencode 失败：{e}") from e

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise AgentError(f"opencode 执行出错：{detail[:500]}")

    # 逐行解析 json，取最后一条 text 作为结果
    final = ""
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        r = result_text(event)
        if r is not None:
            final = r
    return final or proc.stdout.strip()

"""
长期记忆（阶段 3 ①，简版）：本地 SQLite 存"关于主人的关键事实清单"。

  · 闲聊前：format_for_prompt() 把事实拼进 system 提示词
  · 闲聊后：extract_and_store_async() 后台异步从对话抽取新事实写回（不阻塞回复）
  · 全部本地存储，不上传
后续可升级为向量检索。
"""

import os
import sqlite3
import threading
from datetime import datetime

from openai import OpenAI

from config import get_chat_provider, BASE_DIR, provider_kwargs

# 记忆库放在基准目录（开发=源码目录；打包 exe=exe 旁边），与 config.yaml 同处
DB_PATH = os.path.join(BASE_DIR, "memory.db")


def _conn():
    return sqlite3.connect(DB_PATH, timeout=5)


def init_db() -> None:
    with _conn() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS facts ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "content TEXT UNIQUE, "
            "created_at TEXT)"
        )


def get_facts(limit: int = 50) -> list[str]:
    try:
        with _conn() as c:
            rows = c.execute(
                "SELECT content FROM facts ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [r[0] for r in rows][::-1]  # 按时间正序返回
    except Exception:
        return []


def add_fact(content: str) -> None:
    content = content.strip()
    if not content:
        return
    try:
        with _conn() as c:
            c.execute(
                "INSERT OR IGNORE INTO facts (content, created_at) VALUES (?, ?)",
                (content, datetime.now().isoformat()),
            )
    except Exception:
        pass


def clear_facts() -> None:
    try:
        with _conn() as c:
            c.execute("DELETE FROM facts")
    except Exception:
        pass


def format_for_prompt() -> str:
    """把记忆拼成一段注入 system 的文本；没有记忆则返回空串。"""
    facts = get_facts()
    if not facts:
        return ""
    lines = "\n".join(f"- {f}" for f in facts)
    return "（你长期记得的关于主人的事，自然地用，不要生硬复述）：\n" + lines


def extract_and_store_async(user_text: str, assistant_reply: str) -> None:
    """后台线程抽取并存储新事实，不阻塞主回复。"""
    threading.Thread(
        target=_extract_and_store, args=(user_text, assistant_reply), daemon=True
    ).start()


def _extract_and_store(user_text: str, assistant_reply: str) -> None:
    provider = get_chat_provider()
    if not provider.get("api_key"):
        return
    try:
        client = OpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
        resp = client.chat.completions.create(
            model=provider["model"],
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是记忆助手。从对话中提取【关于用户(主人)】值得长期记住的新事实"
                        "（如姓名、称呼偏好、喜好、习惯、重要信息、计划等）。"
                        "要求：每条一行，第三人称简洁陈述，例如'主人喜欢喝美式咖啡'。"
                        "只提取关于用户的、稳定且值得长期记的信息；"
                        "不要提取蛋蛋(助手)自己说的话，不要提取一次性的闲聊内容。"
                        "如果没有值得记的，只回复 NONE。"
                    ),
                },
                {"role": "user", "content": f"用户说：{user_text}\n蛋蛋回：{assistant_reply}"},
            ],
            **provider_kwargs(provider, temperature=0, max_tokens=150),
        )
        out = (resp.choices[0].message.content or "").strip()
        if not out or out.upper().startswith("NONE"):
            return
        for line in out.splitlines():
            fact = line.strip().lstrip("-•*").strip()
            if fact and fact.upper() != "NONE":
                add_fact(fact)
    except Exception:
        pass

"""
闲聊层：调用 DeepSeek / MiMo（OpenAI 兼容接口），带人设 + 多轮历史。

阶段 1 先用最简单的形式：
  · 每个对话会话维护一份历史（在内存里，按会话 id 区分）
  · 每次请求 = system(人设) + 最近 max_history*2 条历史 + 本轮用户输入
  · 记忆库(memory.py)、意图路由(router.py) 是后续阶段的事
"""

from collections import defaultdict, deque

from openai import OpenAI

from config import get_chat_provider, get_persona, provider_kwargs
from memory import extract_and_store_async, format_for_prompt, init_db

init_db()

# 每个会话的历史：sessionid -> deque[ {role, content} ]
_histories: dict[str, deque] = defaultdict(lambda: deque())


class ChatError(Exception):
    """聊天调用出错，带一句给用户看的友好提示。"""


def _client(provider: dict) -> OpenAI:
    if not provider.get("api_key"):
        raise ChatError(
            f"还没配置 {provider['name']} 的 api_key 呢，主人去 config.yaml 填一下吧~"
        )
    return OpenAI(api_key=provider["api_key"], base_url=provider["base_url"])


# 上下文压缩阈值：估算 token 超过此值就把旧对话摘要压缩
_COMPACT_TOKEN_LIMIT = 100_000
# 最近一次 chat() 是否触发了压缩（server 读取后发提示给前端）
_last_compacted = {"flag": False}


def _est_tokens(messages) -> int:
    """粗略估算 token 数：中文≈1字1token，英文≈4字符1token。
    简单起见按 总字符数/2 估（偏保守，宁可早压缩）。"""
    chars = 0
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            chars += len(c)
    return chars // 2


def _compact_history(history, provider, system_content) -> bool:
    """把 history 里较旧的一半对话用 DeepSeek 摘要成一条 system 记录，替换原始消息。
    返回是否成功压缩。"""
    if len(history) < 6:
        return False  # 太短不压缩
    keep = 4  # 保留最近 4 条原文（2 轮），其余压缩
    old = list(history)[:-keep] if len(history) > keep else []
    recent = list(history)[-keep:]
    if not old:
        return False
    convo = "\n".join(
        f"{'主人' if m['role'] == 'user' else '蛋蛋'}：{m.get('content','')}"
        for m in old
    )
    try:
        client = _client(provider)
        resp = client.chat.completions.create(
            model=provider["model"],
            messages=[
                {"role": "system", "content":
                    "把下面主人和桌宠蛋蛋的对话压缩成一段简洁摘要，"
                    "保留关键信息、主人的偏好和未完成的话题，用第三人称陈述，"
                    "不要遗漏重要事实。只输出摘要本身。"},
                {"role": "user", "content": convo},
            ],
            **provider_kwargs(provider, temperature=0, max_tokens=800),
        )
        summary = (resp.choices[0].message.content or "").strip()
        if not summary:
            return False
        # 用一条摘要消息替换掉旧的原始消息
        history.clear()
        history.append({"role": "system", "content": f"（前面对话的摘要）{summary}"})
        for m in recent:
            history.append(m)
        return True
    except Exception:
        return False


def chat(user_text: str, session_id: str = "default") -> str:
    """给一句用户输入，返回桌宠的回复。会自动带上人设与历史。"""
    _last_compacted["flag"] = False
    provider = get_chat_provider()
    persona = get_persona()
    max_turns = provider["max_history"]

    # system 提示词 = 人设 + 长期记忆
    system_content = persona["system_prompt"]
    mem = format_for_prompt()
    if mem:
        system_content += "\n\n" + mem

    history = _histories[session_id]

    # 上下文过长（>100k token）→ 先摘要压缩旧对话
    if _est_tokens([{"content": system_content}, *history]) > _COMPACT_TOKEN_LIMIT:
        if _compact_history(history, provider, system_content):
            _last_compacted["flag"] = True

    messages = [{"role": "system", "content": system_content}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_text})

    client = _client(provider)
    try:
        resp = client.chat.completions.create(
            model=provider["model"],
            messages=messages,
            **provider_kwargs(provider, temperature=0.8),
        )
    except ChatError:
        raise
    except Exception as e:
        raise ChatError(f"蛋蛋的大脑连接出错了：{e}") from e

    reply = resp.choices[0].message.content.strip()

    # 更新历史。上下文长度主要靠 100k token 压缩来控制（见开头 _compact_history），
    # 这里只留一个很宽松的硬上限（防止极端情况无限增长）。
    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": reply})
    _HARD_CAP = 400  # 最多 400 条消息的安全上限
    while len(history) > _HARD_CAP:
        history.popleft()

    # 后台异步抽取并记忆关于主人的新事实（不阻塞本次回复）
    extract_and_store_async(user_text, reply)

    return reply


def did_compact() -> bool:
    """最近一次 chat() 是否触发了上下文压缩（读取即消费）。"""
    v = _last_compacted["flag"]
    _last_compacted["flag"] = False
    return v


def reset_history(session_id: str = "default") -> None:
    _histories.pop(session_id, None)

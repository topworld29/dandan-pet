"""
意图路由：判断用户这句话是「闲聊」(chat) 还是「干活」(task)。

两段式（文档 4.1）：
  1. 规则预筛：含明显动作动词/关键词 → 倾向 task
  2. 小模型兜底：用便宜的 DeepSeek 做一次轻量分类，把模糊情况判清
"""

from openai import OpenAI

from config import get_chat_provider

# 明显的"干活"动作关键词。命中即倾向 task（再交给小模型确认也行，这里直接判 task 省一次调用）。
TASK_KEYWORDS = [
    "整理", "创建", "新建", "建个", "建一个", "删除", "删掉", "重命名", "改名",
    "移动", "复制", "打开", "运行", "跑一下", "跑个", "执行", "查找", "搜索文件",
    "列出", "列目录", "读取", "写入", "保存到", "下载", "生成文件", "归类", "分类整理",
]


def _rule_is_task(text: str) -> bool:
    return any(kw in text for kw in TASK_KEYWORDS)


# 路由用的轻量分类客户端（复用，不每次新建）
_llm_client = None

def _get_llm_client():
    global _llm_client
    provider = get_chat_provider()
    if not provider.get("api_key"):
        return None, None
    if _llm_client is None:
        _llm_client = OpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
    return _llm_client, provider["model"]


def _llm_classify(text: str) -> str:
    """用 DeepSeek 轻量分类，返回 'chat' 或 'task'。出错时保守判 chat（避免误起 Claude Code）。"""
    client, model = _get_llm_client()
    if not client:
        return "chat"
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是一个意图分类器。判断用户的话是想[闲聊/情感交流](chat)，"
                        "还是想[让电脑助手在本机执行任务，比如操作文件、查资料、跑程序](task)。"
                        "只输出一个词：chat 或 task，不要解释。"
                    ),
                },
                {"role": "user", "content": text},
            ],
            temperature=0,
            max_tokens=4,
        )
        ans = resp.choices[0].message.content.strip().lower()
        return "task" if "task" in ans else "chat"
    except Exception:
        return "chat"


def route(text: str) -> str:
    """返回 'chat' 或 'task'。"""
    if _rule_is_task(text):
        return "task"
    return _llm_classify(text)

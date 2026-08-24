"""
权限网关：给"干活"任务分风险等级，决定是否需要用户确认。

风险分级（文档 4.4）：
  · 安全：读文件、搜索、列目录、查询 → 不打扰
  · 风险：创建/修改/删除/移动文件、跑命令 → 需确认
  · 越界：白名单目录之外 → 拦截（命令行阶段靠 cwd + 沙箱约束，自然语言难精确判断，暂归风险确认）

模式：
  · bc（B+C 默认）：仅风险任务确认
  · strict（A 严格）：所有任务都确认
"""

# 风险动作关键词（命中即视为风险，需要确认）
RISKY_KEYWORDS = [
    "创建", "新建", "建个", "建一个", "写入", "保存", "生成文件",
    "删除", "删掉", "清空", "移动", "复制", "覆盖", "重命名", "改名", "替换",
    "运行", "执行", "跑", "命令", "整理", "归类", "分类整理", "下载",
]


def classify_risk(task_text: str) -> str:
    """返回 'safe' 或 'risky'。"""
    if any(kw in task_text for kw in RISKY_KEYWORDS):
        return "risky"
    return "safe"


def needs_confirm(task_text: str, mode: str = "build") -> bool:
    """两种模式都不需要蛋蛋层的确认弹窗：
    · build 全自动干活（opencode --auto 自动批准）
    · plan  只读，不改文件，无需确认
    """
    return False

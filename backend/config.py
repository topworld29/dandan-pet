"""配置加载：读取 config.yaml，提供给后端各模块使用。"""

import os
import sys
from functools import lru_cache

import yaml

# 打包成 exe（PyInstaller，sys.frozen=True）时 __file__ 指向打包内部临时目录，
# config.yaml 实际放在 exe 旁边；开发模式仍在源码目录。两种模式统一取"基准目录"。
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(__file__)

CONFIG_PATH = os.path.join(BASE_DIR, "config.yaml")


@lru_cache(maxsize=1)
def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def reload_config() -> None:
    """清掉 lru_cache，下次调用 load_config() 会重新从文件读取。
    用于设置窗修改 key 后让后端热更新配置，不必重启。"""
    load_config.cache_clear()
    print(f"[config] 配置已重载（缓存已清）", flush=True)


def get_chat_provider() -> dict:
    """返回当前选用的闲聊大脑配置（含 base_url/model/api_key），并附上 provider 名。"""
    cfg = load_config()
    chat = cfg["chat"]
    name = chat["provider"]
    provider = dict(chat["providers"][name])
    provider["name"] = name
    provider["max_history"] = chat.get("max_history", 10)
    return provider


def provider_kwargs(provider: dict, temperature=None, max_tokens=None) -> dict:
    """按服务商的「参数方言」拼出 chat.completions.create() 的额外参数。

    各家对这两个参数要求不一样，差异写在 config.yaml 的 provider 块里：
      · max_tokens_param     —— 长度上限用哪个参数名
      · supports_temperature —— 能不能传 temperature

    2026-08-22 实测：OpenAI 新一代模型（gpt-5.x / o 系列）传 max_tokens 会
    400「Use 'max_completion_tokens' instead」，传 temperature=0 或 0.7 也会
    400「Only the default (1) is supported」。DeepSeek 两个都吃。

    缺省值按 DeepSeek 那套走，所以以后加别的 OpenAI 兼容服务多半不用改配置。
    """
    kw = {}
    if max_tokens is not None:
        kw[provider.get("max_tokens_param") or "max_tokens"] = max_tokens
    if temperature is not None and provider.get("supports_temperature", True):
        kw["temperature"] = temperature
    return kw


def get_agent() -> dict:
    """返回干活引擎(Claude Code)配置。"""
    cfg = load_config()
    return dict(cfg.get("agent", {}))


def get_voice() -> dict:
    """返回语音(TTS/STT)配置。"""
    cfg = load_config()
    return dict(cfg.get("voice", {}))


def get_proactive() -> dict:
    """返回主动触发配置。"""
    cfg = load_config()
    return dict(cfg.get("proactive", {}))


def get_persona() -> dict:
    """返回人设：pet_name / user_title / 渲染好的 system_prompt。"""
    cfg = load_config()
    persona = dict(cfg["persona"])
    persona["system_prompt"] = persona["system_prompt"].format(
        pet_name=persona["pet_name"],
        user_title=persona["user_title"],
    )
    return persona

"""
语音输出（阶段 3 ③）：调 MiMo TTS 把毛毛的回复合成语音，在本机扬声器播放。

MiMo TTS 接口（chat completions 形式）：
  POST {base_url}/chat/completions
  headers: api-key
  body: model=mimo-v2.5-tts, messages=[{role:assistant, content:要念的文字}],
        audio={format:wav, voice:Chloe}
  返回: choices[0].message.audio.data 为 base64 的 wav
"""

import base64
import re
import threading

import httpx

from config import get_voice

# 停止代际：每次 stop() 自增；合成线程记住启动时的代际，
# 若合成完成时代际已变，说明期间被叫停，就不播了（解决"合成中被静音仍会播"）。
_stop_gen = 0
_gen_lock = threading.Lock()
_cur_buf = None  # SND_ASYNC 播放期间保活的音频缓冲区


# ---- 念之前清掉颜文字 / emoji（只影响语音，聊天窗显示的文字不变）----

# 成对括号：括号里若不含中文/英文/数字，判定为颜文字整段删掉，
# 例如 (≧▽≦) (๑• . •๑) (｡･ω･｡)；而 (主人) (note) 这类有正常文字的保留。
_PAREN_GROUP = re.compile(r"[(（][^()（）]*[)）]")
_HAS_WORD = re.compile(r"[A-Za-z0-9一-鿿]")

# emoji 与各类装饰符号区段（箭头/数学符号/几何图形/杂项符号/emoji）
_SYMBOLS = re.compile(
    "["
    "\U0001F000-\U0001FAFF"   # emoji 主区
    "\U00002600-\U000027BF"   # 杂项符号 + Dingbats
    "\U00002190-\U000021FF"   # 箭头
    "\U00002200-\U000022FF"   # 数学运算符 (含 ≧ ≦)
    "\U00002B00-\U00002BFF"
    "\U000025A0-\U000025FF"   # 几何图形 (含 ▽)
    "️"                  # 变体选择符
    "]+",
    flags=re.UNICODE,
)


def _clean_for_tts(text: str) -> str:
    """去掉颜文字和 emoji，返回适合朗读的纯文本。"""
    text = _PAREN_GROUP.sub(lambda m: m.group(0) if _HAS_WORD.search(m.group(0)) else "", text)
    text = _SYMBOLS.sub("", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def speak(text: str) -> None:
    """异步合成并播放（不阻塞调用方）。未启用或无 key 时静默跳过。"""
    cfg = get_voice()
    if not (cfg.get("enabled") and cfg.get("tts_enabled")):
        return
    if not cfg.get("api_key"):
        return
    spoken = _clean_for_tts(text or "")
    if not spoken:
        return
    with _gen_lock:
        gen = _stop_gen
    threading.Thread(target=_synth_and_play, args=(spoken, cfg, gen), daemon=True).start()


def _synth_and_play(text: str, cfg: dict, gen: int) -> None:
    try:
        wav = synthesize(text, cfg)
        # 合成期间若被 stop()，代际会变 → 放弃播放
        with _gen_lock:
            if gen != _stop_gen:
                return
        if wav:
            _play_wav(wav)
    except Exception:
        pass


def synthesize(text: str, cfg: dict | None = None) -> bytes | None:
    cfg = cfg or get_voice()
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"api-key": cfg["api_key"], "Content-Type": "application/json"}
    body = {
        "model": cfg.get("tts_model", "mimo-v2.5-tts"),
        "messages": [{"role": "assistant", "content": text}],
        "audio": {"format": "wav", "voice": cfg.get("voice", "Chloe")},
        "stream": False,
    }
    r = httpx.post(url, headers=headers, json=body, timeout=30)
    r.raise_for_status()
    data = r.json()
    b64 = data["choices"][0]["message"]["audio"]["data"]
    return base64.b64decode(b64)


def _play_wav(wav_bytes: bytes) -> None:
    """在本机播放 wav（Windows 用 winsound）。
    SND_MEMORY + SND_ASYNC 在 Windows 不支持（RuntimeError），
    改用临时文件 + SND_FILENAME + SND_ASYNC：
    这样既能异步播放（stop() 的 SND_PURGE 能打断），
    又不受"缓冲区必须保活"的限制。"""
    import tempfile, os
    try:
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.write(fd, wav_bytes)
        os.close(fd)
        import winsound
        winsound.PlaySound(tmp, winsound.SND_FILENAME | winsound.SND_ASYNC)
        # SND_ASYNC 立即返回，稍后再清理临时文件（播放期间文件不能删）
        # 用后台线程在足够时间后删除
        import threading
        def _cleanup():
            import time; time.sleep(120)
            try: os.unlink(tmp)
            except Exception: pass
        threading.Thread(target=_cleanup, daemon=True).start()
    except Exception:
        pass


def stop() -> None:
    """立刻停止正在播放的语音（让蛋蛋闭嘴），并作废正在合成中的那句。"""
    global _stop_gen
    with _gen_lock:
        _stop_gen += 1
    try:
        import winsound
        winsound.PlaySound(None, winsound.SND_PURGE)
    except Exception:
        pass

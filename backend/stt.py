"""
语音输入（阶段 3 ③）：录麦克风 + 调 MiMo ASR 转文字。

用法（按住说话）：
  recorder.start()  → 开始录音
  wav = recorder.stop()  → 停止并拿到 wav 字节
  transcribe(wav)   → 文字

MiMo ASR 接口（chat completions 形式）：
  POST {base_url}/chat/completions
  body: model=mimo-v2.5-asr,
        messages=[{role:user, content:[{type:input_audio,
                   input_audio:{data:"data:audio/wav;base64,..."}}]}],
        asr_options={language:auto}
  返回: choices[0].message.content 为识别文字
"""

import base64
import io
import wave

import httpx

from config import get_voice

SAMPLE_RATE = 16000
CHANNELS = 1


# 静音自动停止参数
_SILENCE_RMS = 300        # int16 幅度 RMS 阈值，低于视为静音（调低=更不容易误判静音，说话轻也不会被切）
_SILENCE_SECONDS = 2.2    # 连续静音多久就自动停（调长=给你更多停顿空间，不会话没说完就停）
_MIN_SPEAK_SECONDS = 0.5  # 至少录这么久才允许因静音停（避免刚开口就停）


class Recorder:
    """点击说话的录音器：start 开流、stop 收流出 wav。
    带静音检测：连续静音一段时间后 silent_done() 返回 True，服务端据此自动停止。"""

    def __init__(self):
        self._stream = None
        self._frames = []
        self._silent_blocks = 0
        self._voiced = False       # 是否检测到过说话
        self._elapsed = 0.0
        self._auto_stopped = False

    def start(self) -> None:
        import numpy as np
        import sounddevice as sd

        self.stop_silently()
        self._frames = []
        self._silent_blocks = 0
        self._voiced = False
        self._elapsed = 0.0
        self._auto_stopped = False

        def callback(indata, frames, time_info, status):
            b = bytes(indata)
            self._frames.append(b)
            # 计算这一块的 RMS 幅度
            arr = np.frombuffer(b, dtype=np.int16).astype(np.float32)
            if arr.size:
                rms = float(np.sqrt(np.mean(arr * arr)))
                dur = arr.size / SAMPLE_RATE
                self._elapsed += dur
                if rms >= _SILENCE_RMS:
                    self._voiced = True
                    self._silent_blocks = 0
                else:
                    self._silent_blocks += dur
                # 说过话 + 已录够最短时长 + 连续静音超阈值 → 标记自动停
                if (self._voiced and self._elapsed >= _MIN_SPEAK_SECONDS
                        and self._silent_blocks >= _SILENCE_SECONDS):
                    self._auto_stopped = True

        self._stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16", callback=callback
        )
        self._stream.start()

    def silent_done(self) -> bool:
        """是否已因持续静音而应自动停止。"""
        return self._auto_stopped and self._stream is not None

    def stop(self) -> bytes | None:
        if self._stream is None:
            return None
        try:
            self._stream.stop()
            self._stream.close()
        finally:
            self._stream = None
        if not self._frames:
            return None
        pcm = b"".join(self._frames)
        self._frames = []
        pcm = _boost_volume(pcm)  # 自动放大音量，帮助 ASR 识别更准
        return _pcm_to_wav(pcm)

    def stop_silently(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None


# 单用户单桌宠，用一个全局录音器即可
recorder = Recorder()

# 音量放大参数
_TARGET_PEAK = 26000   # 目标峰值（int16 满幅 32767），把最响的地方拉到这个水平
_MAX_GAIN = 8.0        # 最大放大倍数，防止把纯噪声放得太大


def _boost_volume(pcm: bytes) -> bytes:
    """自动增益：把录音整体放大到合适音量（峰值归一化 + 削峰保护）。
    录音音量偏小是 ASR 字错的常见原因，放大后识别通常更准。"""
    try:
        import numpy as np
        arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
        if arr.size == 0:
            return pcm
        peak = float(np.max(np.abs(arr)))
        if peak < 1:
            return pcm  # 几乎全静音，不处理
        gain = min(_MAX_GAIN, _TARGET_PEAK / peak)
        if gain <= 1.05:
            return pcm  # 音量已够，不放大
        boosted = np.clip(arr * gain, -32768, 32767).astype(np.int16)
        return boosted.tobytes()
    except Exception:
        return pcm


def _pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(2)  # int16
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def transcribe(wav_bytes: bytes) -> str:
    cfg = get_voice()
    if not cfg.get("api_key"):
        return ""
    b64 = base64.b64encode(wav_bytes).decode()
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"api-key": cfg["api_key"], "Content-Type": "application/json"}
    body = {
        "model": cfg.get("asr_model", "mimo-v2.5-asr"),
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": f"data:audio/wav;base64,{b64}"},
                    }
                ],
            }
        ],
        "asr_options": {"language": cfg.get("asr_language", "zh")},
    }
    r = httpx.post(url, headers=headers, json=body, timeout=30)
    r.raise_for_status()
    content = r.json()["choices"][0]["message"]["content"]
    if isinstance(content, list):  # 兜底：有些实现返回分段
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return (content or "").strip()

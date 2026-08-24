"""阶段 0 自测脚本：连上后端 WebSocket，发两条消息，打印回复。"""

import asyncio
import json
import urllib.request

import websockets


async def main():
    # 1) 先测 HTTP 健康检查
    with urllib.request.urlopen("http://127.0.0.1:8765/health") as resp:
        print("HTTP /health ->", resp.read().decode())

    # 2) 再测 WebSocket echo
    async with websockets.connect("ws://127.0.0.1:8765/ws") as ws:
        for msg in ["你好", json.dumps({"text": "整理一下文件夹"}, ensure_ascii=False)]:
            await ws.send(msg)
            reply = await ws.recv()
            print(f"发送 {msg!r}  ->  收到 {reply}")


if __name__ == "__main__":
    asyncio.run(main())

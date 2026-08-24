# 毛毛桌宠 —— Python 后端

阶段 0：FastAPI + WebSocket echo 骨架。监听 `127.0.0.1:8765`（仅本机）。

## 目录说明

| 文件 | 作用 |
|------|------|
| `server.py` | 后端服务主程序（HTTP `/health` + WebSocket `/ws` echo） |
| `requirements.txt` | Python 依赖清单 |
| `test_echo.py` | 自测脚本：连上后端发消息、验证回复 |
| `venv/` | Python 虚拟环境（已装好依赖，不用动） |

## 启动服务

在 PowerShell 里进入本目录后运行：

```powershell
.\venv\Scripts\python.exe server.py
```

看到 `Uvicorn running on http://127.0.0.1:8765` 即启动成功。按 `Ctrl+C` 停止。

## 验证是否正常

**方法一（浏览器）**：启动后，浏览器打开 http://127.0.0.1:8765/health
应看到类似 `{"status":"ok",...}` 的返回。

**方法二（自测脚本）**：另开一个 PowerShell 窗口，进入本目录运行：

```powershell
$env:PYTHONUTF8=1; .\venv\Scripts\python.exe test_echo.py
```

应看到 echo 回复，例如：
```
发送 '你好'  ->  收到 {"type": "reply", "text": "毛毛收到啦：你好"}
```

> 注：`$env:PYTHONUTF8=1` 只是让中文在终端正常显示，不影响功能。

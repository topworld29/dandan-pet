# 安全说明（Security）

## 支持的版本

| 版本 | 支持状态 |
| --- | --- |
| 0.2.3（当前） | ✅ 接受问题反馈并修复 |
| 0.2.2 | ✅ 接受问题反馈并修复 |
| 0.2.1 及更早 | ❌ 不再修复，请升级到最新版 |

运行平台仅支持 **Windows 10 / 11 x64**，其他系统不在支持范围内。

## 如何报告安全问题

请**不要**在公开 Issue 里贴出 API Key、完整日志、`config.yaml` 原文，或含个人路径、聊天内容的截图。

- 首选：在本仓库页面 **Security → Report a vulnerability**（GitHub 私有漏洞报告）提交，内容只有仓库所有者可见。
- 备选：如果该入口不可用，先开一个**不含敏感细节**的 Issue，说明「有安全问题需要私下沟通」，等待仓库所有者（GitHub 用户 `topworld29`）联系你。

本项目不提供专门的安全联络邮箱，所有沟通走 GitHub。

## 密钥处理约定（尤其给 fork 和二次开发者）

`backend/config.yaml` 里存着**明文 API Key**，一旦提交到公开仓库，Key 等同于公开作废。

- 该文件已在 `.gitignore` 中排除；仓库里只提交空 Key 模板 `backend/config.example.yaml`。
- **不要**用 `git add -f` 强行加入它，也不要把它复制成 `config.backup.yaml`、`config.我的.yaml` 之类的名字再提交——`.gitignore` 只挡住了原名。
- 提交前扫一遍暂存区，例如查看 `git diff --cached` 的全文，或用 `git diff --cached` 配合关键词搜索确认没有 `api_key:`、`sk-` 开头的字符串。日常也可以直接检查 `git status` 里是否意外出现了 `config.yaml`。
- 打包 / 分发安装包前，先把 `config.yaml` 里的两处 `api_key` 清空——安装包里的 `resources\backend\config.yaml` 会原样带上你的 Key。
- 录屏、截图演示前，注意设置窗的 Key 输入框和 `%USERPROFILE%\.config\opencode\opencode.json`（蛋蛋会把同一份 Key 同步写在那里，见 [PRIVACY.md](PRIVACY.md)）。
- **万一已经提交过 Key**：第一件事是去服务商后台吊销 / 重置这个 Key，然后再清理 Git 历史。只补一个「删掉它」的提交是没用的，Key 仍留在历史记录里。

## 已知安全限制

以下都是当前版本确实存在的限制，如实列出供你评估：

1. **API Key 明文存储，且有两份副本**
   `backend/config.yaml` 与 `%USERPROFILE%\.config\opencode\opencode.json` 都以明文保存 Key，未使用 Windows 凭据管理器或 DPAPI 加密。同一台机器上任何能读你用户目录的程序都能拿到它。暂无加密存储方案。

2. **本地 WebSocket 无鉴权**
   后端的 `ws://127.0.0.1:8765/ws` 不校验身份、来源或 Origin，安全性完全依赖「只绑定回环地址」这一点——外部网络连不上它。但**本机上的其他进程（包括你打开的任意网页里的脚本）理论上都能连上这个端口**，以你的身份发消息、触发干活任务、消耗你的 API 额度。在多人共用或不受信任的机器上请注意这一点。

3. **agent 的 build 模式可读写文件、执行命令**
   `build` 构建模式下 opencode 带 `--auto` 自动批准权限，不会逐步向你确认。它的作用范围**只由设置窗里的「工作目录」（白名单目录）限制**——那是子进程的 cwd。
   - 请把工作目录设成一个**专门的沙箱文件夹**，不要设成用户主目录、桌面或整个磁盘根目录。
   - 拿不准的任务先用 `plan` 计划模式（只读，不改文件）跑一遍看它打算做什么。
   - 注意提示注入风险：模型的输出会驱动真实的文件与命令操作，而网页、文档、截图里的文字都可能藏着诱导性指令。不要在 `build` 模式下让它处理来路不明的内容。

4. **安装包未签名**
   项目未配置代码签名证书，NSIS 安装包首次运行可能触发 Windows SmartScreen 警告。请只从本仓库的 GitHub Release 页面下载安装包。

5. **数据会离开本机**
   聊天内容、翻译文本、截图图片都会发送给你自己配置的模型服务商。完整清单见 [PRIVACY.md](PRIVACY.md)。

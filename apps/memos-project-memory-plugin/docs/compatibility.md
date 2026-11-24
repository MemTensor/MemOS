# 兼容性与验收范围

实现 22 个注册 profile：15 Hook、6 原生扩展、1 RPC。**注册、生成入口、fixture 测试通过，不等于真实宿主主链路验收完成。**

- [Hook 15 项逐项证据](compatibility-hooks.md)
- [原生扩展与 RPC 7 项](compatibility-native.md)

运行环境：实际验证 macOS、Node 26.4.0；声明最低 Node 24.12，尚无最低版本实测。Linux/Windows 路径与进程实现存在，但未实机验收。CodeBuddy Windows 要求 Git Bash。宿主 SDK 只在对应入口加载，不由公共服务集中加载。

版本探测只报告目标版本匹配/未验证/未检测，不自动等同于功能兼容。宿主信任确认、桌面产品的真实触发时机、未公开的注入入口均不能由安装 manifest 代替。

全部 22 宿主真实两轮输入、同轮工具调用、实际模型上下文、Skill 查询和安装卸载仍需环境验证。明确缺口持续记录在分项表；不降低首发范围或将 Skill-only 计为完整接入。

## 对话绑定身份传递

绑定命令只要求 Space ID。自动身份路径：Codex `CODEX_THREAD_ID`、Copilot `COPILOT_AGENT_SESSION_ID`、DSH `DSH_SESSION_ID`；Claude SessionStart 写宿主 `CLAUDE_ENV_FILE`；Cursor/Grok 工具执行前注入；OpenCode v1/Kilo 原生 `shell.env`；Prime `RLM_SESSION_ID`。其他宿主使用现有上下文交付的本轮专属绑定入口，禁止按执行目录或最近会话猜测。22 个安装分支均部署第三个 Skill；真实宿主身份生命周期、模型调用及真实 MemOS 联调仍需实机验收。

## 本地空间查询

22 个 profile 的安装清单均包含第四个 Skill。`memos-pm spaces` 复用绑定的自动身份通道，Cursor/Grok 执行前同时支持零参数查询，Prime 复用准确原生 session／轮次读取，其余宿主复用本轮专属文件的 `spaces` 分支。无需新的宿主配置项或身份参数。Fixture/子进程测试覆盖安装、身份、SQLite 读取和旧绑定兼容，仍不代表全部宿主真实模型交互已验收。

## 对话解绑

22 个 profile 的安装清单均纳入第五个 Skill，卸载沿用归属与哈希保护。解绑命令只要求 Space ID，复用现有身份通道；Cursor/Grok执行前识别unbind，其余原生环境与Prime身份读取无需新增变量，本轮专属文件增加unbind分支。Fixture、子进程及本地SQLite验证不构成全部宿主真实模型交互验收。

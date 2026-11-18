# 兼容性与验收范围

实现 22 个注册 profile：15 Hook、6 原生扩展、1 RPC。**注册、生成入口、fixture 测试通过，不等于真实宿主主链路验收完成。**

- [Hook 15 项逐项证据](compatibility-hooks.md)
- [原生扩展与 RPC 7 项](compatibility-native.md)

运行环境：实际验证 macOS、Node 26.4.0；声明最低 Node 24.12，尚无最低版本实测。Linux/Windows 路径与进程实现存在，但未实机验收。CodeBuddy Windows 要求 Git Bash。宿主 SDK 只在对应入口加载，不由公共服务集中加载。

版本探测只报告目标版本匹配/未验证/未检测，不自动等同于功能兼容。宿主信任确认、桌面产品的真实触发时机、未公开的注入入口均不能由安装 manifest 代替。

全部 22 宿主真实两轮输入、同轮工具调用、实际模型上下文、Skill 查询和安装卸载仍需环境验证。明确缺口持续记录在分项表；不降低首发范围或将 Skill-only 计为完整接入。

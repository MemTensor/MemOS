# 复用范围与来源

参考仓库：`/Users/niu/code/Memos/yjn_dev/memmy-agent`，检查时 HEAD `e640129a40807522c6c1e4db0c2d3f4f0cb3477d`。此为参考版本，不表示整个提交被迁移。

参考范围：

- `Memory/src/agent-source/runtime.ts`：宿主来源分离、源记录去重、会话扫描组织。
- `Memory/src/agent-source/integration/workspace-bridge/runtime.ts`：独立接入桥接入口。
- `Memory/AgentSourceCore/src/index.ts` 及宿主读取模块：原始轨迹与 native ID 的来源。
- `Memory/src/cli/npm/package.json`：包资源与入口组织；该包为下载 Memmy 二进制的壳，不适用本插件。

本插件为独立 TypeScript 实现，未复制整个模块，未使用私有工作区依赖或 Memmy 二进制。运行依赖仅 Node 内置模块，SQLite 使用 `node:sqlite`；开发依赖 TypeScript、Node 类型定义。

不引入：L1/L2/L3、摘要提炼、embedding、向量库、模型推理、预算系统、记忆演化、Memmy 通知与会话管理 UI。未改动同仓库 `memos-local-plugin`。

Memmy CLI npm 配置标记 `UNLICENSED`。不替其宣称开源授权；本包保持 private，发布许可证和主体须单独确认。

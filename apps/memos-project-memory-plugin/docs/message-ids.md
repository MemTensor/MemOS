# 上传消息 ID 与历史 409 修复

`messages[].id` 标识消息。`tool_calls[].id` 与 `tool_call_id` 标识一次工具执行：调用和结果使用相同执行 ID，但必须有不同消息 ID。算法协议只将 `id` 映射为 `message_id`，不负责修正消息身份。

可信的一对一原生消息保留原生 ID。一个原生消息拆成多个记录时，以原生消息 ID 和稳定的片段标识派生子消息 ID；有原生块 ID 时优先使用它，否则使用原始记录内的位置。没有原生消息 ID 的工具事件使用现有 `sourceId` 和来源会话身份生成确定性哈希。ID 不依赖上传批次、Space 或重试次数。

共享上传校验在组批与发送前拒绝重复 ID，保留完整消息并报告重复位置。

## 历史失败批次

源码修复不会自动改写或重传旧快照。正式部署构建后使用以下命令；开发时也可直接运行 `node src/cli/repair-message-ids.ts` 并传入相同参数。维护工具默认以只读方式打开已有 SQLite 文件，只预览：

```sh
node dist/cli/repair-message-ids.js --db "$HOME/.memos-project-memory/memory.sqlite"
```

可用 `--batch-id <id>` 限定单个批次。确认预览结果后，暂停上传并执行本地修复：

```sh
node dist/cli/repair-message-ids.js --db "$HOME/.memos-project-memory/memory.sqlite" --apply
```

工具仅处理消息 ID 确实重复，且所有已有目标都明确因该 HTTP 409 被拒绝、没有 task ID 的失败快照。保存的来源必须能够逐条完整对应原请求；任一来源还关联已接收或结果不确定的请求时，跳过该批次。网络错误、其他 409、成功快照及来源不完整的批次均不改动。

实际修复前创建权限为 `0600` 的 SQLite 备份。事务中修复规范化消息 ID 和失败快照，保留原始 `raw`、`sourceId`、正文、工具关联、发送次数与目标绑定；在诊断中记录批次、旧/新 ID、原错误和备份位置。若预览期间数据库发生并发写入，修复终止，不写入修复结果。

修复后批次与投递状态为 `blocked`，不会自动发送。需要在 Viewer 显式补传项目历史，使用修复后的来源生成请求。修复本身不访问云服务，也不改变成功回执。

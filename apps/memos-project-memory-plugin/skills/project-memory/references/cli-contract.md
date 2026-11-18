# CLI 契约

```sh
memos-pm search --session-id '<session_id>' --conversation-id '<conversation_id>' --query '问题'
```

三个参数均必填。`session_id` 表示当前会话窗口；`conversation_id` 表示当前用户输入轮。两者只用于本地定位及检索归属，不是云端同名参数。适配器负责逐轮交付，不写入静态 Skill。

一条命令覆盖项目当前绑定的全部 Space：本地服务一次性补齐云端请求的 `space_ids` 列表。无需按 Space 多次调用，也不由模型填写或管理 Space ID；绑定列表为空时返回 `UNAVAILABLE`。

参数可由宿主的运行上下文交付。历史中保留的旧上下文不代表当前参数；使用当前生效的会话与轮次标识。本轮标识不可用时，不能回退到历史标识。Skill 简介与动态参数均不替代完整使用说明。

stdout 仅含 JSON，stderr 为简短诊断。典型成功结构：

```json
{
  "ok": true,
  "status": "FOUND",
  "data": {
    "topics": []
  },
  "error": null
}
```

此处空数组仅展示结构，不是实际命中。主题可能包含决策、经验、时间线及各决策所属的历史与冲突；保留其关联，不将多项结论压成单一事实。仅引用实际返回的作者与时间，不补造来源。

| status | 退出码 | 处理 |
|---|---:|---|
| FOUND | 0 | 有匹配结果，核对适用性后使用 |
| EMPTY | 0 | 查询成功但无匹配结果 |
| UNAVAILABLE | 非零 | 暂不可用，不能伪装为无记忆 |
| INVALID_QUERY | 非零 | query 缺失或为空白，修正 query |
| CONTEXT_MISSING | 非零 | 标识缺失、未知、错配或过期；使用当前适配器交付标识 |

不提供额外配置参数或管理子命令。用户、Agent 及项目归属由本地服务负责。记忆不可用不阻止宿主继续原任务。

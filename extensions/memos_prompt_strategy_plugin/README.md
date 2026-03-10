# Prompt Strategy Plugin

根据消息内容自动分类，为不同类型的对话选择最优的记忆提取 prompt。

## 解决什么问题

默认的 mem-reader 对所有消息使用同一套 prompt 模板（chat / doc / general\_string），无法针对不同对话场景做精细化提取。例如：

- 闲聊中的偏好信息容易被忽略
- 任务型对话的截止日期和行动项提取不够结构化
- 代码讨论中的技术细节会被当作普通文本处理

本插件通过 **规则分类器 + 策略 prompt 注册表** 解决这个问题，整个过程对 CE 代码完全透明。

## 工作原理

```
消息进入 mem-reader
    ↓
CE: _get_llm_response() 构建默认 prompt
    ↓
CE: trigger_hook("mem_reader.pre_extract")  ← 通用扩展点
    ↓
插件回调 on_pre_extract():
    1. MessageClassifier 对消息分类 → 得到类别标签
    2. StrategyRegistry 根据标签选择对应的 prompt 模板
    3. 返回定制 prompt（或 None 走默认）
    ↓
CE: LLM.generate(prompt)
```

分类和 prompt 路由全部在插件内部完成，CE 只暴露了一个通用的 `mem_reader.pre_extract` 扩展点。

## 支持的分类类别

| 类别 | 判定规则 | Prompt 策略 |
|------|---------|------------|
| `casual_chat` | 单轮、短文本、无明确任务意图 | 轻量提取，关注偏好和习惯 |
| `task_oriented` | 含任务关键词（请、安排、deadline 等） | 结构化提取，关注任务、截止日期、约束 |
| `knowledge_sharing` | 长文本（>800 字符）、多段落 | 类文档提取，关注概念和定义 |
| `emotional` | 含情感词汇（开心、担心、grateful 等） | 关注情感状态、人际关系 |
| `code_discussion` | 含代码块或技术关键词 | 技术记忆提取，关注工具、框架、解决方案 |
| `multi_turn_qa` | 4+ 轮对话且含多个问句 | 关注结论和最终答案 |

分类器采用**规则优先**策略，零 LLM 开销。可选配置 LLM 兜底处理模糊场景。

## 文件结构

```
extensions/memos_prompt_strategy_plugin/
├── __init__.py        # 包入口，导出 PromptStrategyPlugin
├── plugin.py          # 插件主类：生命周期 + 注册
├── hooks.py           # Hook 回调：on_pre_extract
├── classifier.py      # 消息分类器（规则 + 可选 LLM）
├── strategies.py      # 策略注册表 + 6 套 prompt 模板（中英文）
├── routes.py          # 管理接口
├── example.py         # 可直接运行的分类演示
└── tests/
    ├── conftest.py
    ├── test_classifier.py
    ├── test_strategies.py
    └── test_lifecycle.py
```

## 快速体验

不需要启动服务，直接运行 example 查看分类效果：

```bash
PYTHONPATH="src:extensions" python extensions/memos_prompt_strategy_plugin/example.py
```

## 安装与注册

`pyproject.toml` 中已包含以下配置：

```toml
# 包路径
[tool.poetry]
packages = [
    {include = "memos_prompt_strategy_plugin", from = "extensions"},
]

# Entry point
[project.entry-points."memos.plugins"]
prompt_strategy = "memos_prompt_strategy_plugin:PromptStrategyPlugin"
```

如果是首次安装，需要执行：

```bash
pip install -e .
```

## 运行测试

```bash
PYTHONPATH="src:extensions" python -m pytest extensions/memos_prompt_strategy_plugin/tests/ -v
```

## 管理接口

插件注册了以下 HTTP 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/prompt_strategy/health` | GET | 插件健康检查 |
| `/prompt_strategy/strategies` | GET | 列出所有已注册的策略及描述 |
| `/prompt_strategy/stats` | GET | 查看各分类的命中次数统计 |

## 自定义策略

可以在插件初始化后动态注册新策略：

```python
from memos_prompt_strategy_plugin.strategies import PromptStrategy

plugin.registry.register(PromptStrategy(
    name="legal_discussion",
    template_en="Extract legal terms, clauses...\n${conversation}\n${custom_tags_prompt}",
    template_zh="提取法律术语、条款...\n${conversation}\n${custom_tags_prompt}",
    description="法律讨论场景的记忆提取",
))
```

同时在 `classifier.py` 中添加对应的分类规则即可生效。

## CE 依赖

本插件依赖 CE 侧的一个扩展点：

- `mem_reader.pre_extract`：在 `MultiModalStructMemReader._get_llm_response()` 中，LLM 调用前触发

该扩展点声明在 `src/memos/plugins/hook_defs.py`，修改后需通过 `sync-public` 同步到公开仓库。

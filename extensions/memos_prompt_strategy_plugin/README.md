# Prompt Strategy Plugin

检测对话中的身份/亲属关系命名模式（如"我叫xxx"、"我的儿子叫xxx"），自动切换为专用的身份关系提取 prompt。

## 解决什么问题

默认的 mem-reader prompt 是通用型的，在遇到"我叫王沐辰，我的儿子叫王明泽"这类包含姓名和关系信息的对话时，可能无法精确提取出所有人名和关系。本插件增加一条专用规则：一旦检测到身份/关系命名句式，就替换为专门强调"不遗漏任何人名和关系"的提取 prompt。

如果对话不包含这类句式，插件不做任何改动，走 CE 默认流程。

## 工作原理

```
消息进入 mem-reader
    ↓
CE: _get_llm_response() 构建默认 prompt
    ↓
CE: trigger_hook("mem_reader.pre_extract")  ← 通用扩展点
    ↓
插件回调 on_pre_extract():
    1. MessageClassifier 检查是否命中身份/关系命名规则
    2. 命中 → 返回专用 identity_relation prompt
    3. 不命中 → 返回 None，CE 使用默认 prompt
    ↓
CE: LLM.generate(prompt)
```

## 命中规则

| 模式 | 示例 |
|------|------|
| 自我命名（中文） | 我叫xxx、我是xxx、我的名字是xxx |
| 亲属/社交关系命名（中文） | 我的儿子叫xxx、我老婆是xxx、我妈妈叫xxx、我朋友叫xxx |
| 自我命名（英文） | My name is xxx、I'm xxx、Call me xxx |
| 关系命名（英文） | My son is called xxx、My wife's name is xxx |

支持的关系词：儿子、女儿、老婆、老公、爸爸、妈妈、哥哥、姐姐、弟弟、妹妹、爷爷、奶奶、朋友、同事、同学、宠物等。

## 文件结构

```
extensions/memos_prompt_strategy_plugin/
├── __init__.py        # 包入口，导出 PromptStrategyPlugin
├── plugin.py          # 插件主类：生命周期 + 注册
├── hooks.py           # Hook 回调：on_pre_extract
├── classifier.py      # 身份/关系命名规则检测
├── strategies.py      # identity_relation prompt 模板（中英文）
├── routes.py          # 管理接口
├── example.py         # 可直接运行的检测演示
└── tests/
    ├── conftest.py
    ├── test_classifier.py
    ├── test_strategies.py
    └── test_lifecycle.py
```

## 快速体验

```bash
PYTHONPATH="src:extensions" python extensions/memos_prompt_strategy_plugin/example.py
```

## 安装与注册

`pyproject.toml` 中已包含以下配置：

```toml
[tool.poetry]
packages = [
    {include = "memos_prompt_strategy_plugin", from = "extensions"},
]

[project.entry-points."memos.plugins"]
prompt_strategy = "memos_prompt_strategy_plugin:PromptStrategyPlugin"
```

首次安装需执行：

```bash
pip install -e .
```

## 运行测试

```bash
PYTHONPATH="src:extensions" python -m pytest extensions/memos_prompt_strategy_plugin/tests/ -v
```

## 管理接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/prompt_strategy/health` | GET | 插件健康检查 |
| `/prompt_strategy/stats` | GET | 查看 identity_relation 命中次数 |

## CE 依赖

本插件依赖 CE 侧的一个扩展点：

- `mem_reader.pre_extract`：在 `MultiModalStructMemReader._get_llm_response()` 中，LLM 调用前触发

该扩展点声明在 `src/memos/plugins/hook_defs.py`。

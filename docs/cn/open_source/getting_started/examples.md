---
title: MemOS 示例
desc: "恭喜你——你已经掌握了快速入门并构建了第一个可用的记忆！现在是时候通过结合不同的记忆类型和功能，看看 MemOS 可以实现多大的可能性。使用这些精选示例来激发你自己的智能体、聊天机器人或知识系统的灵感。"
---

::card-group

  :::card
  ---
  icon: ri:play-line
  title: 最简Pipeline
  to: /cn/open_source/getting_started/examples#示例-1最简pipeline
  ---
  最小的可用Pipeline  — 添加、搜索明文记忆。
  :::

  :::card
  ---
  icon: ri:tree-line
  title: 多信息源的添加与检索
  to: /cn/open_source/getting_started/examples#示例-2多信息源记忆的添加与检索
  ---
  添加文本、图片、文件、工具调用的多信息源messages到记忆，并能够检索它们。
  :::

  :::card
  ---
  icon: ri:apps-line
  title: 多Cube添加和检索
  to: /cn/open_source/getting_started/examples#示例-3多cube添加和检索
  ---
  添加不同记忆到不同的Cube，在检索时同时召回它们。
  :::

  :::card
  ---
  icon: ri:database-2-line
  title: 仅 KVCacheMemory
  to: /cn/open_source/getting_started/examples#示例-4仅-kvcachememory
  ---
  使用短期 KV cache加速会话，实现快速上下文注入。
  :::

  :::card
  ---
  icon: ri:calendar-check-line
  title: 记忆调度
  to: /cn/open_source/getting_started/examples#示例-5多忆调度
  ---
  为多用户、多会话智能体运行动态记忆调用。
  :::

::

## 示例 1：最简Pipeline

### 何时使用：
- 你想要最小的入门可用示例。
- 你只需要将简单的明文记忆存储到数据库中，并能够检索它们。

### 关键点：
- 支持基础的个人用户记忆添加、搜索。

### 完整示例代码
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_1"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_1"],
    messages = [
      {"role": "user", "content": "I’ve planned to travel to Guangzhou during the summer vacation. What chain hotels are available for accommodation?"},
      {"role": "assistant", "content": "You can consider [7 Days Inn, Ji Hotel, Hilton], etc."},
      {"role": "user", "content": "I’ll choose 7 Days Inn."},
      {"role": "assistant", "content": "Okay, feel free to ask me if you have any other questions."}
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_1"],
    query="Please recommend a hotel that I haven’t stayed at before.",
    include_preference=True,
)

search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
````

## 示例 2：多信息源记忆的添加与检索

### 何时使用：

- 除单纯的文本对话外，你需要将文件、图片内容或工具调用历史信息加入记忆
- 同时你想要检索这些多源信息的记忆

### 关键点：

- 多种信息来源的记忆添加
- 需要有可下载的文件、图片url
- 添加的信息需要严格符合OpenAI Messages格式
- system prompt中的工具Schema需要包装在<tool_chema> </tool_schema>中

### 完整示例代码
添加文本+文件到记忆中
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_2"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_2"],
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Please read this file, summarize the key points, and provide a final conclusion."
                },
                {
                    "type": "file",
                    "file": {
                    "file_id": "file_123",
                    "filename": "report.md",
                    "file_data": "@http://139.196.232.20:9090/graph-test/algorithm/2025_11_13/1763043889_1763043782_PM1%E8%BD%A6%E9%97%B4PMT%E9%9D%B4%E5%8E%8B%E8%BE%B9%E5%8E%8B%E5%8E%8B%E5%8A%9B%E6%97%A0%E6%B3%95%E5%BB%BA%E7%AB%8B%E6%95%85%E9%9A%9C%E6%8A%A5%E5%91%8A20240720.md"
                    }
                },
            ]
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "Final Summary: During the PMT boot-pressure startup test of the PM1 workshop on July 20, 2024, the drive could not run because the edge pressures on both sides failed to reach the 2.5-bar interlock requirement. After troubleshooting, the PLC output signals, hydraulic pipelines, and valves were all found to be normal. The root cause was ultimately identified as poor contact at the negative terminal of the proportional valve’s DC 24V power supply inside the PLC cabinet, caused by a short-jumpered terminal block. After re-connecting the negative incoming lines in parallel, the equipment returned to normal operation. It is recommended to replace terminal blocks in batches, inspect instruments with uncertain service life, and optimize the troubleshooting process by tracing common-mode issues from shared buses and power supply sources."
                }
            ]
        }
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_2"],
    query="Workshop PMT boot pressure startup test",
    include_preference=False,
)
search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```
添加多种混合信息源的messages到记忆中
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_2"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_2"],
    messages = [
  {
    "role": "system",
    "content": [
      {
        "type": "text",
        "text": "You are a professional industrial fault analysis assistant. Please read the PDF, images, and instructions provided by the user and provide a professional technical summary.\n\n<tool_schema>\n[\n  {\n    \"name\": \"file_reader\",\n    \"description\": \"Used to read the content of files uploaded by the user and return the text data (in JSON string format).\",\n    \"parameters\": [\n      {\"name\": \"file_id\", \"type\": \"string\", \"required\": true, \"description\": \"The file ID to be read\"}\n    ],\n    \"returns\": {\"type\": \"text\", \"description\": \"Returns the extracted text content of the file\"}\n  }\n]\n</tool_schema>"
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Please read this file and image, summarize the key points, and provide a final conclusion."
      },
      {
        "type": "file",
        "file": {
          "file_id": "file_123",
          "filename": "report.pdf",
          "file_data": "@http://139.196.232.20:9090/graph-test/algorithm/2025_11_13/1763043889_1763043782_PM1%E8%BD%A6%E9%97%B4PMT%E9%9D%B4%E5%8E%8B%E8%BE%B9%E5%8E%8B%E5%8E%8B%E5%8A%9B%E6%97%A0%E6%B3%95%E5%BB%BA%E7%AB%8B%E6%95%85%E9%9A%9C%E6%8A%A5%E5%91%8A20240720.md"
        }
      },
      {
        "type": "image_url",
        "image_url": {
          "url": "https://play-groud-test-1.oss-cn-shanghai.aliyuncs.com/%E5%9B%BE%E7%89%871.jpeg"
        }
      }
    ]
  },
  {
    "role": "assistant",
    "tool_calls": [
      {
        "id": "call_file_reader_001",
        "type": "function",
        "function": {
          "name": "file_reader",
          "arguments": "{\"file_id\": \"file_123\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_file_reader_001",
    "content": [
      {
        "type": "text",
        "text": "{\"file_id\":\"file_123\",\"extracted_text\":\"PM1 workshop PMT boot pressure startup test record… Final fault cause: poor contact at the negative terminal of the DC 24V power supply circuit due to a short-jumped terminal block.\"}"
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Final Summary: During the PMT boot-pressure startup test of the PM1 workshop on July 20, 2024, the drive could not run because the edge pressures on both sides failed to reach the 2.5-bar interlock requirement. After troubleshooting, the PLC output signals, hydraulic pipelines, and valves were all found to be normal. The root cause was ultimately identified as poor contact at the negative terminal of the proportional valve’s DC 24V power supply inside the PLC cabinet, caused by a short-jumpered terminal block. After re-connecting the negative incoming lines in parallel, the equipment returned to normal operation. It is recommended to replace terminal blocks in batches, inspect instruments with uncertain service life, and optimize the troubleshooting process by tracing common-mode issues from shared buses and power supply sources."
      }
    ]
  }
],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)

print("add_memories rsp: \n\n", add_rsp)



search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_2"],
    query="Workshop PMT boot pressure startup test",
    include_preference=False,
)

search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```

## 示例 3：多Cube添加和检索

### 何时使用：

- 向彼此隔离的不同的Cube空间中添加记忆
- 你希望同时检索不同Cube空间中的记忆

### 关键点：

- 在检索时输入含有多个cube id的readable_cube_ids列表

### 完整示例代码
```python
import json
from memos.api.routers.server_router import add_memories, search_memories
from memos.api.product_models import APIADDRequest, APISearchRequest

user_id = "test_user_3"
add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_3_1"] ,
    messages = [
      {"role": "user", "content": "I’ve planned to travel to Guangzhou during the summer vacation. What chain hotels are available for accommodation?"},
      {"role": "assistant", "content": "You can consider [7 Days Inn, Ji Hotel, Hilton], etc."},
      {"role": "user", "content": "I’ll choose 7 Days Inn."},
      {"role": "assistant", "content": "Okay, feel free to ask me if you have any other questions."}
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

add_req = APIADDRequest(
    user_id=user_id,
    writable_cube_ids=["cube_test_user_3_2"] ,
    messages = [
      {"role": "user", "content": "I love you, I need you."},
      {"role": "assistant", "content": "Wow, I love you too"},
    ],
    async_mode="sync",
    mode="fine",
)

add_rsp = add_memories(add_req)
print("add_memories rsp: \n\n", add_rsp)

search_req = APISearchRequest(
    user_id=user_id,
    readable_cube_ids=["cube_test_user_3_1", "cube_test_user_3_2"],
    query="Please recommend a hotel, Love u u",
    include_preference=True,
)

search_rsp = search_memories(search_req).data
print("\n\nsearch_rsp: \n\n", json.dumps(search_rsp, indent=2, ensure_ascii=False))
```

## 示例 4：仅 KVCacheMemory

### 何时使用：

- 你想要短期工作记忆以加快多轮对话速度。
- 适合聊天机器人会话加速或提示复用。
- 最适合缓存隐藏状态 / KV 对。

### 关键点：

- 使用 KVCacheMemory，不含显式明文记忆。
- 演示提取 → 添加 → 合并 → 获取 → 删除。
- 展示如何导出/加载 KV cache。

### 完整示例代码


```python
import json
from transformers import DynamicCache

from memos.memories.activation.item import KVCacheItem
from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

def get_cache_info(cache):
    if not cache:
        return None

    num_layers = 0
    total_size_bytes = 0

    if hasattr(cache, "layers"):
        num_layers = len(cache.layers)
        for layer in cache.layers:
            if hasattr(layer, "key_cache") and layer.key_cache is not None:
                total_size_bytes += layer.key_cache.nelement() * layer.key_cache.element_size()
            if hasattr(layer, "value_cache") and layer.value_cache is not None:
                total_size_bytes += layer.value_cache.nelement() * layer.value_cache.element_size()

            if hasattr(layer, "keys") and layer.keys is not None:
                total_size_bytes += layer.keys.nelement() * layer.keys.element_size()
            if hasattr(layer, "values") and layer.values is not None:
                total_size_bytes += layer.values.nelement() * layer.values.element_size()

    elif hasattr(cache, "key_cache") and hasattr(cache, "value_cache"):
        num_layers = len(cache.key_cache)
        for k, v in zip(cache.key_cache, cache.value_cache, strict=False):
            if k is not None:
                total_size_bytes += k.nelement() * k.element_size()
            if v is not None:
                total_size_bytes += v.nelement() * v.element_size()

    return {
        "num_layers": num_layers,
        "size_bytes": total_size_bytes,
        "size_mb": f"{total_size_bytes / (1024 * 1024):.2f} MB",
    }


def serialize_item(obj):
    if isinstance(obj, list):
        return [serialize_item(x) for x in obj]

    if isinstance(obj, KVCacheItem):
        return {
            "id": obj.id,
            "metadata": obj.metadata,
            "records": obj.records.model_dump()
            if hasattr(obj.records, "model_dump")
            else obj.records,
            "memory": get_cache_info(obj.memory),
        }

    if isinstance(obj, DynamicCache):
        return get_cache_info(obj)

    return str(obj)


# 为 KVCacheMemory(HuggingFace 后端)创建配置
config = MemoryConfigFactory(
    backend="kv_cache",
    config={
        "extractor_llm": {
            "backend": "huggingface",
            "config": {
                "model_name_or_path": "Qwen/Qwen3-0.6B",
                "max_tokens": 32,
                "add_generation_prompt": True,
                "remove_think_prefix": True,
            },
        },
    },
)

# 实例化 KVCacheMemory
kv_mem = MemoryFactory.from_config(config)

# 提取一个 KVCacheItem(DynamicCache)
prompt = [
    {"role": "user", "content": "What is MemOS?"},
    {"role": "assistant", "content": "MemOS is a memory operating system for LLMs."},
]
print("===== Extract KVCacheItem =====")
cache_item = kv_mem.extract(prompt)
print(json.dumps(serialize_item(cache_item), indent=2, default=str))

# 将缓存添加到内存中
kv_mem.add([cache_item])
print("All caches:")
print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))

# 通过 ID 获取
retrieved = kv_mem.get(cache_item.id)
print("Retrieved:")
print(json.dumps(serialize_item(retrieved), indent=2, default=str))

# 合并缓存
item2 = kv_mem.extract([{"role": "user", "content": "Tell me a joke."}])
kv_mem.add([item2])
merged = kv_mem.get_cache([cache_item.id, item2.id])
print("Merged cache:")
print(json.dumps(serialize_item(merged), indent=2, default=str))

# 删除其中一个
kv_mem.delete([cache_item.id])
print("After delete:")
print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))

# 导出和加载缓存
kv_mem.dump("tmp/kv_mem")
print("Dumped to tmp/kv_mem")
kv_mem.delete_all()
kv_mem.load("tmp/kv_mem")
print("Loaded caches:")
print(json.dumps(serialize_item(kv_mem.get_all()), indent=2, default=str))
```

## 示例 5：记忆调度

### 何时使用：

- 你希望自定义记忆调度逻辑或扩展后台任务，以异步触发的方式不断对记忆进行管理和优化。
- 适用于 SaaS 智能体或多会轮对话的LLM应用任务。
- 展示 MemScheduler的记忆管理任务设置与运行方式。

### 关键点：

- 通过 `mem_scheduler.register_handlers` 注册自定义回调。
- 使用 `add_handler` 和 `chat_stream_playground` 进行交互。
- 演示了如何获取和使用从环境量初始化完成的MemScheduler实例。

### 完整示例代码

```python
import asyncio
import json
import os
import sys
import time

from pathlib import Path


# 在依赖路径的导入之前设置路径
FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # 启用从任何工作目录执行

# 在导入 server_router 之前设置环境变量，以确保组件正确初始化
os.environ["ENABLE_CHAT_API"] = "true"

from memos.api.product_models import APIADDRequest, ChatPlaygroundRequest  # noqa: E402

# 从 server_router 导入以进行初始化
from memos.api.routers.server_router import (  # noqa: E402
    add_handler,
    chat_stream_playground,
    mem_scheduler,
)
from memos.log import get_logger  # noqa: E402
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem  # noqa: E402
from memos.mem_scheduler.schemas.task_schemas import (  # noqa: E402
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)


logger = get_logger(__name__)


def init_task():
    conversations = [
        {"role": "user", "content": "I just adopted a golden retriever puppy yesterday."},
        {"role": "assistant", "content": "Congratulations! What did you name your new puppy?"},
        {
            "role": "user",
            "content": "His name is Max. I live near Central Park in New York where we'll walk daily.",
        },
        {"role": "assistant", "content": "Max will love those walks! Any favorite treats for him?"},
        {
            "role": "user",
            "content": "He loves peanut butter biscuits. Personally, I'm allergic to nuts though.",
        },
        {"role": "assistant", "content": "Good to know about your allergy. I'll note that."},
        # 问题 1 (宠物) - 名字
        {"role": "user", "content": "What's my dog's name again?"},
        {"role": "assistant", "content": "Your dog is named Max."},
        # 问题 2 (宠物) - 品种
        {"role": "user", "content": "Can you remind me what breed Max is?"},
        {"role": "assistant", "content": "Max is a golden retriever."},
        # 问题 3 (宠物) - 零食
        {"role": "user", "content": "What treats does Max like?"},
        {"role": "assistant", "content": "He loves peanut butter biscuits."},
        # 问题 4 (地址)
        {"role": "user", "content": "Where did I say I live?"},
        {"role": "assistant", "content": "You live near Central Park in New York."},
        # 问题 5 (过敏)
        {"role": "user", "content": "What food should I avoid due to allergy?"},
        {"role": "assistant", "content": "You're allergic to nuts."},
        {"role": "user", "content": "Perfect, just wanted to check what you remembered."},
        {"role": "assistant", "content": "Happy to help! Let me know if you need anything else."},
    ]

    questions = [
        {"question": "What's my dog's name again?", "category": "Pet"},
        {"question": "Can you remind me what breed Max is?", "category": "Pet"},
        {"question": "What treats does Max like?", "category": "Pet"},
        {"question": "Where did I say I live?", "category": "Address"},
        {"question": "What food should I avoid due to allergy?", "category": "Allergy"},
    ]
    return conversations, questions


working_memories = []


# 定义自定义查询处理函数
def custom_query_handler(messages: list[ScheduleMessageItem]):
    for msg in messages:
        # 打印用户输入内容
        print(f"\n[scheduler] User input query: {msg.content}")
        # 手动构造带有 MEM_UPDATE 标签的新消息以触发记忆更新
        new_msg = msg.model_copy(update={"label": MEM_UPDATE_TASK_LABEL})
        # 提交消息给调度器处理
        mem_scheduler.submit_messages([new_msg])


# 定义自定义记忆更新处理函数
def custom_mem_update_handler(messages: list[ScheduleMessageItem]):
    global working_memories
    search_args = {}
    top_k = 2
    for msg in messages:
        # 在文本记忆中搜索与当前内容相关的记忆（返回 top_k=2）
        results = mem_scheduler.retriever.search(
            query=msg.content,
            user_id=msg.user_id,
            mem_cube_id=msg.mem_cube_id,
            mem_cube=mem_scheduler.current_mem_cube,
            top_k=top_k,
            method=mem_scheduler.search_method,
            search_args=search_args,
        )
        working_memories.extend(results)
        working_memories = working_memories[-5:]
        for mem in results:
            print(f"\n[scheduler] Retrieved memory: {mem.memory}")


async def run_with_scheduler():
    print("==== run_with_automatic_scheduler_init ====")
    conversations, questions = init_task()

    # 使用 server_router 组件进行初始化
    # 配置通过 init_server() 中的环境变量加载

    user_id = "user_1"
    mem_cube_id = "mem_cube_5"

    print(f"Adding conversations for user {user_id}...")

    # 使用 add_handler 添加记忆
    add_req = APIADDRequest(
        user_id=user_id,
        writable_cube_ids=[mem_cube_id],
        messages=conversations,
        async_mode="sync",  # 在此示例中使用同步模式以便立即添加
    )
    add_handler.handle_add_memories(add_req)

    for item in questions:
        print("===== Chat Start =====")
        query = item["question"]
        print(f"Query:\n {query}\n")

        # 使用 chat_handler 进行聊天
        chat_req = ChatPlaygroundRequest(
            user_id=user_id,
            query=query,
            readable_cube_ids=[mem_cube_id],
            writable_cube_ids=[mem_cube_id],
        )
        response = chat_stream_playground(chat_req)

        answer = ""
        buffer = ""
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8")
            buffer += chunk
            while "\n\n" in buffer:
                msg, buffer = buffer.split("\n\n", 1)
                for line in msg.split("\n"):
                    if line.startswith("data: "):
                        json_str = line[6:]
                        try:
                            data = json.loads(json_str)
                            if data.get("type") == "text":
                                answer += data["data"]
                        except json.JSONDecodeError:
                            pass
        print(f"\nAnswer: {answer}")


if __name__ == "__main__":
    mem_scheduler.register_handlers(
        {
            QUERY_TASK_LABEL: custom_query_handler,  # 查询任务
            MEM_UPDATE_TASK_LABEL: custom_mem_update_handler,  # 记忆更新任务
        }
    )

    asyncio.run(run_with_scheduler())

    time.sleep(20)
    mem_scheduler.stop()
```

::note
**请注意**<br>
使用 dump() 和 load() 来持久化你的记忆立方体。

务必确保你的向量数据库维度与你的嵌入器匹配。

如使用基于图的明文记忆功能，你需要安装 Neo4j Desktop。
::

## 下一步

你才刚刚开始！接下来可以尝试：

- 选择与你使用场景匹配的示例。
- 组合模块以构建更智能、更持久的智能体！

还需要更多帮助？
查看 API 文档或贡献你自己的示例吧！

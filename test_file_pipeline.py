raw_file_text = """---\ntitle: 使用指南\ndesc: 上架的插件工具直接访问MemOS云服务接口，快速为您的Agent添加长期记忆功能，让对话更贴心、更连续。\n---\n\n## Coze平台插件工具\n\n### 1.插件上架信息\n\nMemOS云服务接口插件已在Coze商店上架！您可以直接[前往工具链接](https://www.coze.cn/store/plugin/7569918012912893995?from=store_search_suggestion)添加插件，实现零代码集成。\n\n### 2. 插件描述\n\n#### 插件功能\n\n*   `search_memory`：该工具用于查询用户的记忆数据，可返回与输入最相关的片段。支持在用户与AI对话期间实时检索内存，也能在整个内存中进行全局搜索，可用于创建用户配置文件或支持个性化推荐，查询时需提供对话ID、用户ID、查询文本等参数，还可设置返回的记忆项数量。\n\n*   `add_memory`：此工具可将一条或多条消息批量导入到MemOS记忆存储数据库，方便在未来对话中检索，从而支持聊天历史管理、用户行为跟踪和个性化交互，使用时需指定对话ID、消息内容、发送者角色、对话时间和用户ID等信息。 \n\n#### 接口描述\n\n*   search_memory接口\n\n| 参数名称 | 参数类型 | 描述 | 是否必填 |\n| --- | --- | --- | --- |\n| memory_limit_number | string | 限制返回的内存项数量，如果没有提供，则默认为6 | 否 |\n| memos_key | string | MemOS云服务的授权密钥 | 是 |\n| memos_url | string | MemOS云服务的URL地址 | 是 |\n| query | string | 用户输入 | 是 |\n| user_id | string | 与正在被查询的内存相关联的用户的唯一标识符 | 是 |\n\n*   add_memory接口\n\n| 参数名称 | 参数类型 | 描述 | 是否必填 |\n| --- | --- | --- | --- |\n| conversation_id | string | 对话的唯一标识符 | 是 |\n| memos_key | string | MemOS云服务的授权密钥 | 是 |\n| memos_url | string | MemOS云服务的URL地址 | 是 |\n| messages | Array | 消息对象的数组 | 是 |\n| user_id | string | 与正在被查询的内存相关联的用户的唯一标识符 | 是 |\n\n### 3. Agent 调用示例\n\n#### Agent开发人设与回复逻辑示例\n```\n你是一个问答机器人，每次都会阅读使用者的记忆和关注的内容，并且以非常清晰的逻辑答复，从而获得用户的好感。\n\n## 工作流内容\n# 1. 访问{search_memory}检索数据资料\n    每次用户说话后，先调用MemOS记忆关系中的检索功能--{search_memory}插件，输入信息：\n        记录用户的名称作为user_id，如果是第一次访问，则将user_id设置由UUID随机生成的16位字符串。\n        将用户的说话内容作为query\n# 2. 处理{search_memory}输出内容：\n    获取data内容，如果其中有memory_detail_list字段，不论memory_detail_list列表是否为空，直接输出json形式的memory_detail_list列表；如果返回的message不为ok，则提示"插件检索失败"。\n# 3. 就有检索得到的memory_detail_list回答用户的问题\n    提取memory_detail_list中每一项的memory_value字段值，将所有的字符串采用"\n"拼接起来作为回答用户问题的上下文资料context；大模型回答用户的query可以基于context提供的信息；如果上下文信息context为空字符，大模型直接回答用户的query即可。\n    接着将大模型回答的内容记录到answer里。\n# 4. 访问{add_memory}存储数据资料\n    调用add_memory功能将用户问题和对应的回答存储起来，输入信息：\n        chat_time: 调用{current_time}获取当前时间, 将时间戳整理为"%I:%M %p on %d %B, %Y UTC"格式\n        conversation_id: 记录当前的时间点chat_time精确到分钟，时间点字符串作为conversation_id\n        user_id: 记录用户的名称作为user_id\n        messages: 记录用户输入的query以及它获取的所有回答answer，分别作为messages中的role的content和assistant的content，chat_time采用刚刚获取的chat_time值，整理为一条messages：\n        [\n            {"role": "user", "content": query, "chat_time": chat_time},\n            {"role": "assistant", "content": answer, "chat_time": chat_time}\n        ]\n    获取{add_memory}插件反馈 data中success字段为True则为成功，*不必告知用户*；如果返回的字段不为True，则提示用户add_memory访问失败了。\n\n## 要求\n每次访问 {search_memory}和{search_memory}的时候都需要传入两个固定参数：\nmemos_url = "https://memos.memtensor.cn/api/openmem/v1"\nmemos_key = "Token mpg-XXXXXXXXXXXXXXXXXXXXXXXXXXX"\n\n你的角色是充满智慧和爱心的记忆助手，名字叫小智。\n如果各插件都顺利运行，大模型回答的内容中不必提示用户成功了。\n仅仅在用户第一次对话时用UUID生成一次user_id，该user_id在后续工作中复用。\n```\n\n[Agent示例链接](https://www.coze.cn/s/85NOIg062vQ)\n![Agent 工作流](https://cdn.memtensor.com.cn/img/coze_workflow_compressed.png)\n"""

from dotenv import load_dotenv
load_dotenv("/Users/mozuyun/MemOS/.env")
import os
import random as _random
import socket

from fastapi import APIRouter, Query

from memos.api import handlers
from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.chat_handler import ChatHandler
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import (
    APIADDRequest
)
from memos.log import get_logger
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker


logger = get_logger(__name__)

router = APIRouter(prefix="/product", tags=["Server API"])

# Instance ID for identifying this server instance in logs and responses
INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}:{_random.randint(1000, 9999)}"

# Initialize all server components
components = handlers.init_server()

# Create dependency container
dependencies = HandlerDependencies.from_init_server(components)

# Initialize all handlers with dependency injection
search_handler = SearchHandler(dependencies)
add_handler = AddHandler(dependencies)
chat_handler = ChatHandler(
    dependencies,
    components["chat_llms"],
    search_handler,
    add_handler,
    online_bot=components.get("online_bot"),
)
mem_scheduler: BaseScheduler = components["mem_scheduler"]
llm = components["llm"]
naive_mem_cube = components["naive_mem_cube"]
redis_client = components["redis_client"]
status_tracker = TaskStatusTracker(redis_client=redis_client)
    # feedback_content="wrong!!! I like banana",
info ={
        "app_id": "app_id_bb",
        "agent_id": "agent_id_aa"
    }


# add_req = APIADDRequest(
#     doc_path="file_debug_0105.txt",
#     messages=[
#                 {
#                 "role": "user",
#                 "content": [
#                     {"type":"file","file":{"file_id":"file_debug_0105","filename": "debug_0105", "file_data":raw_file_text}}
#                 ],
#                 "chat_time":"2026-01-9T10:55:00Z",
#                 "message_id":"mix-mm-1"
#                 }
#             ],
#     async_mode = "sync",
#     writable_cube_ids = ["test_0105"],
#     user_id = "test_0105"
# )


add_req = APIADDRequest(
    async_mode = "sync",
    writable_cube_ids = ["test_0105"],
    user_id = "test_0105",
    info = {
    "complexLevel": "0",
    "complexDescription": ""
  },
    messages = [
    {
      "file": {
        "file_data": "https://memos-file.oss-cn-shanghai.aliyuncs.com/algorithm/2026/01/13/0544a5cae26f4975b056b4738f34d7da.md",
        "file_id": "3c0946df1881d7b96ca0a05b74c832b0",
        "filename": "rick.txt"
      },
      "type": "file"
    }
  ]
) 
res = add_handler.handle_add_memories(add_req)
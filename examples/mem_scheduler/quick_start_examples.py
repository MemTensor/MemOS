import json
import shutil
import sys
import uuid

from pathlib import Path

from transformers import DynamicCache

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.memory import MemoryConfigFactory
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    ANSWER_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)
from memos.mem_scheduler.utils.db_utils import get_utc_now
from memos.mem_scheduler.utils.misc_utils import parse_yaml
from memos.memories.activation.item import KVCacheItem
from memos.memories.factory import MemoryFactory


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


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


def kv_cache_only():
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


def run_scheduler_example():
    # 使用 MemScheduler 加载主 MOS(Memory-Oriented System)配置文件
    config = parse_yaml(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml"
    )
    # 将解析出的配置字典传入 MOSConfig 构造器, 构建配置对象
    mos_config = MOSConfig(**config)
    # 使用配置对象初始化 MOS 系统实例
    mos = MOS(mos_config)

    # 生成一个唯一的动态用户 ID(使用 UUID4)
    user_id = str(uuid.uuid4())
    # 在 MOS 系统中为该用户创建账户
    mos.create_user(user_id=user_id)

    # 从 YAML 文件加载 MemCube(记忆立方体)的通用配置
    config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config.yaml"
    )
    # 定义 MemCube 的唯一标识符
    mem_cube_id = "mem_cube_5"
    # 定义 MemCube 的本地存储路径(路径中包含用户 ID 和 MemCube ID)
    mem_cube_name_or_path = f"{BASE_DIR}/outputs/mem_scheduler/{user_id}/{mem_cube_id}"

    # 如果该路径已存在, 则先删除旧目录
    if Path(mem_cube_name_or_path).exists():
        shutil.rmtree(mem_cube_name_or_path)
        print(f"{mem_cube_name_or_path} 目录非空，已被删除。")

    # 根据加载的配置创建一个新的 MemCube 实例
    mem_cube = GeneralMemCube(config)
    # 将该 MemCube 实例序列化并保存到指定路径
    mem_cube.dump(mem_cube_name_or_path)

    # 在 MOS 系统中为当前用户注册这个 MemCube
    mos.register_mem_cube(
        mem_cube_name_or_path=mem_cube_name_or_path, mem_cube_id=mem_cube_id, user_id=user_id
    )

    # 定义一个辅助函数, 用于获取缓存(如 KV Cache)的内存信息
    def get_cache_info(cache):
        # 如果缓存为空, 则直接返回 None
        if not cache:
            return None

        num_layers = 0  # 记录缓存的层数
        total_size_bytes = 0  # 记录总字节数

        # 情况一: 缓存结构包含 layers 属性(如 HuggingFace 的缓存格式)
        if hasattr(cache, "layers"):
            num_layers = len(cache.layers)
            for layer in cache.layers:
                # 统计 key_cache 的内存占用(如果存在)
                if hasattr(layer, "key_cache") and layer.key_cache is not None:
                    total_size_bytes += layer.key_cache.nelement() * layer.key_cache.element_size()
                # 统计 value_cache 的内存占用(如果存在)
                if hasattr(layer, "value_cache") and layer.value_cache is not None:
                    total_size_bytes += (
                        layer.value_cache.nelement() * layer.value_cache.element_size()
                    )

                # 兼容其他可能的缓存命名方式(如 keys/values)
                if hasattr(layer, "keys") and layer.keys is not None:
                    total_size_bytes += layer.keys.nelement() * layer.keys.element_size()
                if hasattr(layer, "values") and layer.values is not None:
                    total_size_bytes += layer.values.nelement() * layer.values.element_size()

        # 情况二: 缓存结构直接包含 key_cache 和 value_cache 列表(如某些自定义格式)
        elif hasattr(cache, "key_cache") and hasattr(cache, "value_cache"):
            num_layers = len(cache.key_cache)
            for k, v in zip(cache.key_cache, cache.value_cache, strict=False):
                if k is not None:
                    total_size_bytes += k.nelement() * k.element_size()
                if v is not None:
                    total_size_bytes += v.nelement() * v.element_size()

        # 返回结构化的缓存信息, 包括层数, 字节数和以 MB 为单位的可读格式
        return {
            "num_layers": num_layers,
            "size_bytes": total_size_bytes,
            "size_mb": f"{total_size_bytes / (1024 * 1024):.2f} MB",
        }

    # 定义自定义的查询(query)处理函数
    def custom_query_handler(messages: list[ScheduleMessageItem]):
        for msg in messages:
            # 打印用户输入内容
            print(f"\n[scheduler] 用户输入了查询：{msg.content}")
            # 手动构造一个带有 MEM_UPDATE 标签的新消息, 用于触发记忆更新
            new_msg = msg.model_copy(update={"label": MEM_UPDATE_TASK_LABEL})
            # 将该消息提交给调度器处理
            mos.mem_scheduler.submit_messages([new_msg])

    # 定义自定义的回答(answer)处理函数
    def custom_answer_handler(messages: list[ScheduleMessageItem]):
        for msg in messages:
            # 打印 LLM 的回复内容
            print(f"\n[scheduler] LLM 回复了答案：{msg.content}")

    # 定义自定义的记忆更新(mem_update)处理函数
    def custom_mem_update_handler(messages: list[ScheduleMessageItem]):
        for msg in messages:
            mem_cube = mos.mem_cubes.get(msg.mem_cube_id)
            kv_mem = mem_cube.act_mem
            # 如果该 MemCube 配置了文本记忆(TreeTextMemory / NaiveTextMemory)
            if mem_cube and mem_cube.text_mem:
                # 在文本记忆中搜索与当前内容相关的记忆(返回 top_k=3 条)
                results = mem_cube.text_mem.search(msg.content, top_k=3)
                for mem in results:
                    print(f"\n[scheduler] 检索到的记忆：{mem.memory}")
                    print("\n[scheduler] 转换为激活记忆......")
                    # 从文本记忆中提取对应的 KV 缓存项
                    cache_item = kv_mem.extract(mem.memory)
                    # 附加元信息
                    cache_item.records.text_memories = [mem.memory]
                    cache_item.records.timestamp = get_utc_now()
                    # 将该缓存项添加到激活记忆中
                    kv_mem.add([cache_item])
                    print("\n[scheduler] 完成！")

    # 将上述三个自定义处理器注册到调度器的分发器中, 分别对应不同任务标签
    mos.mem_scheduler.dispatcher.register_handlers(
        {
            QUERY_TASK_LABEL: custom_query_handler,  # 查询任务
            ANSWER_TASK_LABEL: custom_answer_handler,  # 回答任务
            MEM_UPDATE_TASK_LABEL: custom_mem_update_handler,  # 记忆更新任务
        }
    )

    # 初始添加两条测试消息(用户和助手的对话)到系统中
    messages = [
        {"role": "user", "content": "I like playing football."},
        {"role": "assistant", "content": "I like playing football too."},
    ]
    mos.add(messages, user_id=user_id, mem_cube_id=mem_cube_id)

    # 进入聊天循环: 展示 TreeTextMemory 的记忆节点结构 + KV Cache 的状态
    while True:
        # 获取用户输入并去除首尾空格
        user_input = input("👤 [You] ").strip()
        print()
        # 调用 MOS 系统进行聊天响应
        response = mos.chat(user_input, user_id=user_id)
        # 获取该用户当前 MemCube 中的所有记忆内容
        retrieved_memories = mos.get_all(mem_cube_id=mem_cube_id, user_id=user_id)

        # 打印助手的回复
        print(f"🤖 [Assistant] {response}")

        # 获取文本记忆部分 - TreeTextMemory
        memories = retrieved_memories["text_mem"][0]["memories"]
        for mem in memories:
            print(f"[文本记忆] {mem.memory}")

        # 获取对应的 MemCube 和其激活记忆(KV Cache)
        mem_cube = mos.mem_scheduler.mem_cube
        kv_mem = mem_cube.act_mem
        # 遍历所有激活记忆项, 打印其缓存信息和记录
        for cache_item in kv_mem.get_all():
            print(f"[激活记忆] {get_cache_info(cache_item.memory)} （记录：{cache_item.records}）")


if __name__ == "__main__":
    kv_cache_only()

    run_scheduler_example()

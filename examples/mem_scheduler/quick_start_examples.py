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
    # 使用 MemScheduler 加载主 MOS 配置
    config = parse_yaml(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml"
    )
    mos_config = MOSConfig(**config)
    mos = MOS(mos_config)

    # 创建动态用户 ID
    user_id = str(uuid.uuid4())
    mos.create_user(user_id=user_id)

    # 创建 MemCube 配置并导出
    config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config.yaml"
    )
    mem_cube_id = "mem_cube_5"
    mem_cube_name_or_path = f"{BASE_DIR}/outputs/mem_scheduler/{user_id}/{mem_cube_id}"

    # 若存在旧目录则删除
    if Path(mem_cube_name_or_path).exists():
        shutil.rmtree(mem_cube_name_or_path)
        print(f"{mem_cube_name_or_path} is not empty, and has been removed.")

    # 导出新的 MemCube
    mem_cube = GeneralMemCube(config)
    mem_cube.dump(mem_cube_name_or_path)

    # 为该用户注册 MemCube
    mos.register_mem_cube(
        mem_cube_name_or_path=mem_cube_name_or_path, mem_cube_id=mem_cube_id, user_id=user_id
    )

    # Define custom scheduler handlers
    def custom_query_handler(messages: list[ScheduleMessageItem]):
        for msg in messages:
            print(f"\n[scheduler] 用户输入了query： {msg.content}")
            # Trigger mem_update manually
            new_msg = msg.model_copy(update={"label": MEM_UPDATE_TASK_LABEL})
            mos.mem_scheduler.submit_messages([new_msg])

    def custom_answer_handler(messages: list[ScheduleMessageItem]):
        for msg in messages:
            mem_cube = mos.mem_cubes.get(msg.mem_cube_id)
            kv_mem = mem_cube.act_mem
            for cache_item in kv_mem.get_all():
                print(
                    f"[scheduler] act memory:  {get_cache_info(cache_item.memory)} ({cache_item.records})"
                )
            print(f"\n[scheduler] LLM回复了answer：{msg.content}")

    def custom_mem_update_handler(messages: list[ScheduleMessageItem]):
        for msg in messages:
            mem_cube = mos.mem_cubes.get(msg.mem_cube_id)
            kv_mem = mem_cube.act_mem
            if mem_cube and mem_cube.text_mem:
                results = mem_cube.text_mem.search(msg.content, top_k=3)
                for mem in results:
                    print(f"\n[scheduler] searched memories: {mem.memory}")

                    cache_item = kv_mem.extract(mem.memory)
                    cache_item.records.text_memories = [mem.memory]
                    cache_item.records.timestamp = get_utc_now()
                    kv_mem.add([cache_item])

    # Register custom handlers
    mos.mem_scheduler.dispatcher.register_handlers(
        {
            QUERY_TASK_LABEL: custom_query_handler,
            ANSWER_TASK_LABEL: custom_answer_handler,
            MEM_UPDATE_TASK_LABEL: custom_mem_update_handler,
        }
    )

    # 添加消息
    messages = [
        {"role": "user", "content": "I like playing football."},
        {"role": "assistant", "content": "I like playing football too."},
    ]
    mos.add(messages, user_id=user_id, mem_cube_id=mem_cube_id)

    # 聊天循环: 展示 TreeTextMemory 节点 + KVCache
    while True:
        user_input = input("👤 [You] ").strip()
        print()
        response = mos.chat(user_input, user_id=user_id)
        retrieved_memories = mos.get_all(mem_cube_id=mem_cube_id, user_id=user_id)

        print(f"🤖 [Assistant] {response}")

        # 展示 TreeTextMemory 中的各类型节点
        text_memories = retrieved_memories["text_mem"][0]["memories"]
        # Handle different memory structures (NaiveTextMemory returns list, TreeTextMemory returns dict with nodes)
        if isinstance(text_memories, dict) and "nodes" in text_memories:
            for node in text_memories["nodes"]:
                mem_type = node["metadata"].get("memory_type", "Unknown")
                print(f"[{mem_type}] {node['memory']}")
        elif isinstance(text_memories, list):
            for mem in text_memories:
                # Naive memory items might not have memory_type metadata, or it might be different
                print(f"[TextMemory] {mem.memory if hasattr(mem, 'memory') else mem}")


if __name__ == "__main__":
    kv_cache_only()

    run_scheduler_example()

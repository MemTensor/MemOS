# memcube_with_structured_memories_api.py
# 🎯 将结构化记忆添加到MemCube的完整示例 (API版)
import os

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.mem_cube.general import GeneralMemCube
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata


def create_memcube_config_api():
    """
    🎯 创建MemCube配置 (API版)
    """

    print("🔧 创建MemCube配置 (API版)...")

    # 加载环境变量
    load_dotenv()

    # 检查API配置
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")

    print("✅ 检测到OpenAI API模式")

    # 获取配置
    user_id = os.getenv("MOS_USER_ID", "default_user")
    top_k = int(os.getenv("MOS_TOP_K", "5"))

    # 获取模型配置
    chat_model = os.getenv("OPENAI_API_CHAT_MODEL", "gpt-4o-mini")
    embed_model = os.getenv("OPENAI_API_EMBED_MODEL", "text-embedding-3-small")

    print(f"🤖 使用聊天模型: {chat_model}")
    print(f"🔍 使用嵌入模型: {embed_model}")

    # OpenAI模式配置
    config = GeneralMemCubeConfig(
        user_id=user_id,
        cube_id=f"{user_id}_structured_memories_cube",
        text_mem={
            "backend": "general_text",
            "config": {
                "extractor_llm": {
                    "backend": "openai",
                    "config": {
                        "model_name_or_path": chat_model,
                        "api_key": openai_key,
                        "api_base": openai_base,
                        "temperature": 0.1,
                        "max_tokens": 1024,
                    },
                },
                "embedder": {
                    "backend": "universal_api",
                    "config": {
                        "provider": "openai",
                        "api_key": openai_key,
                        "model_name_or_path": embed_model,
                        "base_url": openai_base,
                    },
                },
                "vector_db": {
                    "backend": "qdrant",
                    "config": {
                        "collection_name": f"{user_id}_structured_memories",
                        "vector_dimension": 1536,
                        "distance_metric": "cosine",
                    },
                },
            },
        },
        act_mem={"backend": "uninitialized"},
        para_mem={"backend": "uninitialized"},
    )

    return config


def create_structured_memories_api():
    """
    🎯 将结构化记忆添加到MemCube的完整示例 (API版)
    """

    print("🚀 开始创建结构化记忆MemCube (API版)...")

    # 创建MemCube配置
    config = create_memcube_config_api()

    # 创建MemCube
    mem_cube = GeneralMemCube(config)

    print("✅ MemCube创建成功！")
    print(f"  📊 用户ID: {mem_cube.config.user_id}")
    print(f"  📊 MemCube ID: {mem_cube.config.cube_id}")
    print(f"  📊 文本记忆后端: {mem_cube.config.text_mem.backend}")
    print(f"  🔍 嵌入模型: {embed_model} (OpenAI)")
    print("  🎯 配置模式: OPENAI API")

    # 创建多个记忆项
    memories = []

    # 记忆1：人物信息
    person_metadata = TreeNodeTextualMemoryMetadata(
        user_id=mem_cube.config.user_id,
        type="fact",
        source="conversation",
        confidence=90.0,
        memory_type="LongTermMemory",
        key="李四_信息",
        entities=["李四", "设计师"],
        tags=["人员", "设计"],
    )

    memories.append(
        {"memory": "李四是我们的UI设计师，有5年经验，擅长用户界面设计", "metadata": person_metadata}
    )

    # 记忆2：项目信息
    project_metadata = TreeNodeTextualMemoryMetadata(
        user_id=mem_cube.config.user_id,
        type="fact",
        source="file",
        confidence=95.0,
        memory_type="LongTermMemory",
        key="移动应用项目",
        entities=["移动应用", "开发"],
        tags=["项目", "移动端", "重要"],
    )

    memories.append(
        {
            "memory": "移动应用项目正在进行中，预计3个月完成，团队有8个人",
            "metadata": project_metadata,
        }
    )

    # 记忆3：工作记忆
    work_metadata = TreeNodeTextualMemoryMetadata(
        user_id=mem_cube.config.user_id,
        type="procedure",
        source="conversation",
        confidence=85.0,
        memory_type="WorkingMemory",
        key="本周任务",
        tags=["任务", "本周"],
    )

    memories.append(
        {"memory": "本周需要完成需求分析、原型设计、以及技术选型", "metadata": work_metadata}
    )

    # 添加到MemCube
    mem_cube.text_mem.add(memories)

    print("✅ 成功添加了3个记忆项到MemCube")

    # 查询记忆
    print("\n🔍 查询所有记忆:")
    all_memories = mem_cube.text_mem.get_all()
    for i, memory in enumerate(all_memories, 1):
        print(f"{i}. {memory.memory}")
        print(f"   键: {memory.metadata.key}")
        print(f"   类型: {memory.metadata.memory_type}")
        print(f"   标签: {memory.metadata.tags}")
        print()

    # 搜索特定记忆
    print("🔍 搜索包含'李四'的记忆:")
    search_results = mem_cube.text_mem.search("李四", top_k=2)
    for result in search_results:
        print(f"- {result.memory}")

    return mem_cube


if __name__ == "__main__":
    create_structured_memories_api()

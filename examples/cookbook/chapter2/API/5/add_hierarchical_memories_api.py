# add_hierarchical_memories_api.py
# 🎯 添加层次化记忆的示例 (API版)
import os

from dotenv import load_dotenv

from memos.configs.memory import TreeTextMemoryConfig
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree import TreeTextMemory


def add_hierarchical_memories_api():
    """
    🎯 添加层次化记忆的示例 (API版)
    """

    print("🚀 开始添加层次化记忆 (API版)...")

    # 加载环境变量
    load_dotenv()

    # 检查API配置
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")

    print("✅ 检测到OpenAI API模式")

    # 获取用户ID
    user_id = os.getenv("MOS_USER_ID", "default_user")

    # 创建TreeTextMemory配置
    tree_config = TreeTextMemoryConfig(
        extractor_llm={
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-3.5-turbo",
                "api_key": openai_key,
                "api_base": openai_base,
                "temperature": 0.1,
                "max_tokens": 1024,
            },
        },
        dispatcher_llm={
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-3.5-turbo",
                "api_key": openai_key,
                "api_base": openai_base,
                "temperature": 0.1,
                "max_tokens": 1024,
            },
        },
        graph_db={
            "backend": "neo4j",
            "config": {
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "password",
                "db_name": f"{user_id}_hierarchical_memory",
                "auto_create": True,
                "embedding_dimension": 1536,
            },
        },
        embedder={
            "backend": "universal_api",
            "config": {
                "provider": "openai",
                "api_key": openai_key,
                "model_name_or_path": "text-embedding-ada-002",
                "base_url": openai_base,
            },
        },
    )

    # 创建TreeTextMemory实例
    tree_memory = TreeTextMemory(tree_config)

    # 清空现有记忆
    tree_memory.delete_all()

    # 创建层次化记忆结构
    memories = []

    # 根节点：项目概述
    root_metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="topic",
        source="file",
        confidence=95.0,
        memory_type="LongTermMemory",
        key="AI项目_根节点",
        entities=["AI项目", "智能客服"],
        tags=["项目", "根节点", "重要"],
    )

    memories.append(
        {"memory": "AI项目是一个智能客服系统，目标是提升客户服务效率", "metadata": root_metadata}
    )

    # 子节点1：技术架构
    tech_metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="fact",
        source="file",
        confidence=90.0,
        memory_type="LongTermMemory",
        key="技术架构",
        entities=["NLP", "机器学习", "API"],
        tags=["技术", "架构", "重要"],
    )

    memories.append(
        {
            "memory": "项目使用最新的NLP技术和机器学习算法，通过API接口提供服务",
            "metadata": tech_metadata,
        }
    )

    # 子节点2：团队信息
    team_metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="fact",
        source="conversation",
        confidence=85.0,
        memory_type="LongTermMemory",
        key="团队信息",
        entities=["开发团队", "8人"],
        tags=["团队", "人员"],
    )

    memories.append(
        {"memory": "开发团队有8个人，包括前端、后端、AI工程师和产品经理", "metadata": team_metadata}
    )

    # 子节点3：时间计划
    timeline_metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="procedure",
        source="file",
        confidence=80.0,
        memory_type="WorkingMemory",
        key="时间计划",
        entities=["6个月", "里程碑"],
        tags=["计划", "时间", "临时"],
    )

    memories.append(
        {
            "memory": "项目预计6个月完成，分为需求分析、设计、开发、测试四个阶段",
            "metadata": timeline_metadata,
        }
    )

    # 添加记忆到图数据库
    tree_memory.add(memories)

    print("✅ 成功添加了4个层次化记忆节点")

    # 搜索记忆
    print("\n🔍 搜索包含'技术'的记忆:")
    search_results = tree_memory.search("技术", top_k=3)
    for i, result in enumerate(search_results, 1):
        print(f"{i}. {result.memory}")
        print(f"   键: {result.metadata.key}")
        print(f"   类型: {result.metadata.memory_type}")
        print(f"   标签: {result.metadata.tags}")
        print()

    # 获取工作记忆
    print("🔍 获取工作记忆:")
    working_memories = tree_memory.get_working_memory()
    for memory in working_memories:
        print(f"- {memory.memory}")

    return tree_memory


if __name__ == "__main__":
    add_hierarchical_memories_api()

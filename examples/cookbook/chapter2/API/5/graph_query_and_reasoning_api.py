# graph_query_and_reasoning_api.py
# 🎯 图数据库查询和推理示例 (API版)
import os

from dotenv import load_dotenv

from memos.configs.memory import TreeTextMemoryConfig
from memos.memories.textual.tree import TreeTextMemory


def graph_query_and_reasoning_api():
    """
    🎯 图数据库查询和推理示例 (API版)
    """

    print("🚀 开始图数据库查询和推理 (API版)...")

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
                "db_name": f"{user_id}_reasoning_memory",
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

    print("🔍 执行图数据库查询和推理...")

    # 1. 向量相似度搜索
    print("\n1️⃣ 向量相似度搜索:")
    vector_results = tree_memory.search("AI项目", top_k=3)
    for i, result in enumerate(vector_results, 1):
        print(f"   {i}. {result.memory}")

    # 2. 获取所有记忆
    print("\n2️⃣ 获取所有记忆:")
    all_memories = tree_memory.get_all()
    print(f"   总记忆数量: {len(all_memories.get('nodes', []))}")

    # 3. 替换工作记忆
    print("\n3️⃣ 替换工作记忆:")
    new_working_memories = [
        {
            "memory": "当前正在进行需求分析阶段，需要收集用户反馈",
            "metadata": {
                "memory_type": "WorkingMemory",
                "key": "当前状态",
                "tags": ["状态", "当前"],
            },
        }
    ]
    tree_memory.replace_working_memory(new_working_memories)
    print("   ✅ 工作记忆已更新")

    # 4. 备份记忆
    print("\n4️⃣ 备份记忆到文件:")
    backup_dir = "tmp/tree_memory_backup"
    tree_memory.dump(backup_dir)
    print(f"   ✅ 记忆已备份到: {backup_dir}")

    print("\n🎯 配置模式: OPENAI API")
    print("🤖 聊天模型: gpt-3.5-turbo (OpenAI)")
    print("🔍 嵌入模型: text-embedding-ada-002 (OpenAI)")

    return tree_memory


if __name__ == "__main__":
    graph_query_and_reasoning_api()

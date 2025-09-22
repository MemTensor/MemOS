# create_treetext_memory_api.py
# 🎯 创建TreeTextMemory的示例 (API版)
import os
from dotenv import load_dotenv
from memos.configs.memory import TreeTextMemoryConfig
from memos.memories.textual.tree import TreeTextMemory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_treetext_memory_api():
    """
    🎯 创建TreeTextMemory的示例 (API版)
    """
    
    print("🚀 开始创建TreeTextMemory (API版)...")
    
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
            }
        },
        dispatcher_llm={
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-3.5-turbo",
                "api_key": openai_key,
                "api_base": openai_base,
                "temperature": 0.1,
                "max_tokens": 1024,
            }
        },
        graph_db={
            "backend": "neo4j",
            "config": {
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "password",
                "db_name": f"{user_id}_tree_memory",
                "auto_create": True,
                "embedding_dimension": 1536
            }
        },
        embedder={
            "backend": "universal_api",
            "config": {
                "provider": "openai",
                "api_key": openai_key,
                "model_name_or_path": "text-embedding-ada-002",
                "base_url": openai_base,
            }
        }
    )
    
    # 创建TreeTextMemory实例
    tree_memory = TreeTextMemory(tree_config)
    
    print("✅ TreeTextMemory创建成功！")
    print(f"  📊 用户ID: {tree_memory.config.user_id}")
    print(f"  📊 记忆ID: {tree_memory.config.memory_id}")
    print(f"  🔍 嵌入模型: text-embedding-ada-002 (OpenAI)")
    print(f"  🤖 聊天模型: gpt-3.5-turbo (OpenAI)")
    print(f"  🗄️ 图数据库: Neo4j")
    print(f"  🎯 配置模式: OPENAI API")
    
    return tree_memory

if __name__ == "__main__":
    create_treetext_memory_api() 
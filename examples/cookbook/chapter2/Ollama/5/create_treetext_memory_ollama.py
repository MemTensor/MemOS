# create_treetext_memory_ollama.py
# 🎯 创建TreeTextMemory的示例 (Ollama版)
import os
from dotenv import load_dotenv
from memos.configs.memory import TreeTextMemoryConfig
from memos.memories.textual.tree import TreeTextMemory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_treetext_memory_ollama():
    """
    🎯 创建TreeTextMemory的示例 (Ollama版)
    """
    
    print("🚀 开始创建TreeTextMemory (Ollama版)...")
    
    # 加载环境变量
    load_dotenv()
    
    # 检查Ollama配置
    ollama_base_url = os.getenv("OLLAMA_BASE_URL")
    ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
    ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")
    
    if not ollama_base_url or not ollama_chat_model or not ollama_embed_model:
        raise ValueError("❌ 未配置Ollama环境变量。请在.env文件中配置OLLAMA_BASE_URL、OLLAMA_CHAT_MODEL、OLLAMA_EMBED_MODEL。")
    
    print("✅ 检测到Ollama本地模型模式")
    
    # 获取用户ID
    user_id = os.getenv("MOS_USER_ID", "default_user")
    
    # 创建TreeTextMemory配置
    tree_config = TreeTextMemoryConfig(
        extractor_llm={
            "backend": "ollama",
            "config": {
                "model_name_or_path": ollama_chat_model,
                "api_base": ollama_base_url
            }
        },
        dispatcher_llm={
            "backend": "ollama",
            "config": {
                "model_name_or_path": ollama_chat_model,
                "api_base": ollama_base_url
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
                "embedding_dimension": 768
            }
        },
        embedder={
            "backend": "ollama",
            "config": {
                "model_name_or_path": ollama_embed_model,
                "api_base": ollama_base_url
            }
        }
    )
    
    # 创建TreeTextMemory实例
    tree_memory = TreeTextMemory(tree_config)
    
    print("✅ TreeTextMemory创建成功！")
    print(f"  📊 用户ID: {tree_memory.config.user_id}")
    print(f"  📊 记忆ID: {tree_memory.config.memory_id}")
    print(f"  🔍 嵌入模型: {ollama_embed_model} (Ollama)")
    print(f"  🤖 聊天模型: {ollama_chat_model} (Ollama)")
    print(f"  🗄️ 图数据库: Neo4j")
    print(f"  🎯 配置模式: OLLAMA")
    
    return tree_memory

if __name__ == "__main__":
    create_treetext_memory_ollama() 
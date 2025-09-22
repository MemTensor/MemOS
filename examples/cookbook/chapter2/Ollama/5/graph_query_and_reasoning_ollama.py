# graph_query_and_reasoning_ollama.py
# 🎯 图数据库查询和推理示例 (Ollama版)
import os
from dotenv import load_dotenv
from memos.configs.memory import TreeTextMemoryConfig
from memos.memories.textual.tree import TreeTextMemory

def graph_query_and_reasoning_ollama():
    """
    🎯 图数据库查询和推理示例 (Ollama版)
    """
    
    print("🚀 开始图数据库查询和推理 (Ollama版)...")
    
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
                "db_name": f"{user_id}_reasoning_memory",
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
    new_working_memories = [{
        "memory": "当前正在进行需求分析阶段，需要收集用户反馈",
        "metadata": {
            "memory_type": "WorkingMemory",
            "key": "当前状态",
            "tags": ["状态", "当前"]
        }
    }]
    tree_memory.replace_working_memory(new_working_memories)
    print("   ✅ 工作记忆已更新")
    
    # 4. 备份记忆
    print("\n4️⃣ 备份记忆到文件:")
    backup_dir = "tmp/tree_memory_backup"
    tree_memory.dump(backup_dir)
    print(f"   ✅ 记忆已备份到: {backup_dir}")
    
    print(f"\n🎯 配置模式: OLLAMA")
    print(f"🤖 聊天模型: {ollama_chat_model}")
    print(f"🔍 嵌入模型: {ollama_embed_model}")
    
    return tree_memory

if __name__ == "__main__":
    graph_query_and_reasoning_ollama() 
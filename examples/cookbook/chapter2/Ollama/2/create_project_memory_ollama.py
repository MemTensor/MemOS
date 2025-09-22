# create_project_memory_ollama.py
# 🎯 创建项目记忆的示例 (Ollama版)
import os
from dotenv import load_dotenv
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_project_memory_ollama():
    """
    🎯 创建项目记忆的示例 (Ollama版)
    """
    
    print("🚀 开始创建项目记忆 (Ollama版)...")
    
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
    
    # 创建项目记忆的元数据
    project_metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="fact",
        source="file",
        confidence=95.0,
        memory_type="LongTermMemory",
        key="AI项目_详情",
        entities=["AI项目", "机器学习"],
        tags=["项目", "AI", "重要"],
        sources=["项目文档", "会议记录"]
    )

    # 创建记忆项
    project_memory = TextualMemoryItem(
        memory="AI项目是一个智能客服系统，使用最新的NLP技术，预计6个月完成",
        metadata=project_metadata
    )

    print(f"项目记忆: {project_memory.memory}")
    print(f"来源: {project_memory.metadata.sources}")
    print(f"🎯 配置模式: OLLAMA")
    print(f"🤖 聊天模型: {ollama_chat_model}")
    print(f"🔍 嵌入模型: {ollama_embed_model}")
    
    return project_memory

if __name__ == "__main__":
    create_project_memory_ollama() 
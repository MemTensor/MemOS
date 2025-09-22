# create_person_memory_ollama.py
# 🎯 创建人物记忆的示例 (Ollama版)
import os
from dotenv import load_dotenv
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_person_memory_ollama():
    """
    🎯 创建人物记忆的示例 (Ollama版)
    """
    
    print("🚀 开始创建人物记忆 (Ollama版)...")
    
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
    
    # 创建人物记忆的元数据
    metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="fact",
        source="conversation",
        confidence=90.0,
        memory_type="LongTermMemory",
        key="张三_信息",
        entities=["张三", "工程师"],
        tags=["人员", "技术"]
    )

    # 创建记忆项
    memory_item = TextualMemoryItem(
        memory="张三是我们公司的资深工程师，擅长Python和机器学习",
        metadata=metadata
    )

    print(f"记忆内容: {memory_item.memory}")
    print(f"记忆键: {memory_item.metadata.key}")
    print(f"记忆类型: {memory_item.metadata.memory_type}")
    print(f"标签: {memory_item.metadata.tags}")
    print(f"🎯 配置模式: OLLAMA")
    print(f"🤖 聊天模型: {ollama_chat_model}")
    print(f"🔍 嵌入模型: {ollama_embed_model}")
    
    return memory_item

if __name__ == "__main__":
    create_person_memory_ollama() 
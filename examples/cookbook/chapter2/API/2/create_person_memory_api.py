# create_person_memory_api.py
# 🎯 创建人物记忆的示例 (API版)
import os
from dotenv import load_dotenv
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_person_memory_api():
    """
    🎯 创建人物记忆的示例 (API版)
    """
    
    print("🚀 开始创建人物记忆 (API版)...")
    
    # 加载环境变量
    load_dotenv()
    
    # 检查API配置
    openai_key = os.getenv("OPENAI_API_KEY")
    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")
    
    print("✅ 检测到OpenAI API模式")
    
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
    print(f"🎯 配置模式: OPENAI API")
    
    return memory_item

if __name__ == "__main__":
    create_person_memory_api() 
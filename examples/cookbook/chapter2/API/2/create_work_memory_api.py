# create_work_memory_api.py
# 🎯 创建工作记忆的示例 (API版)
import os
from dotenv import load_dotenv
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_work_memory_api():
    """
    🎯 创建工作记忆的示例 (API版)
    """
    
    print("🚀 开始创建工作记忆 (API版)...")
    
    # 加载环境变量
    load_dotenv()
    
    # 检查API配置
    openai_key = os.getenv("OPENAI_API_KEY")
    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")
    
    print("✅ 检测到OpenAI API模式")
    
    # 获取用户ID
    user_id = os.getenv("MOS_USER_ID", "default_user")
    
    # 创建工作记忆的元数据
    work_metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        type="procedure",
        source="conversation",
        confidence=80.0,
        memory_type="WorkingMemory",  # 工作记忆
        key="今日任务",
        tags=["任务", "今日"]
    )

    # 创建记忆项
    work_memory = TextualMemoryItem(
        memory="今天需要完成代码审查、团队会议、以及准备明天的演示",
        metadata=work_metadata
    )

    print(f"工作记忆: {work_memory.memory}")
    print(f"记忆类型: {work_memory.metadata.memory_type}")
    print(f"🎯 配置模式: OPENAI API")
    
    return work_memory

if __name__ == "__main__":
    create_work_memory_api() 
# create_project_memory_api.py
# 🎯 创建项目记忆的示例 (API版)
import os
from dotenv import load_dotenv
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata

def create_project_memory_api():
    """
    🎯 创建项目记忆的示例 (API版)
    """
    
    print("🚀 开始创建项目记忆 (API版)...")
    
    # 加载环境变量
    load_dotenv()
    
    # 检查API配置
    openai_key = os.getenv("OPENAI_API_KEY")
    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")
    
    print("✅ 检测到OpenAI API模式")
    
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
    print(f"🎯 配置模式: OPENAI API")
    
    return project_memory

if __name__ == "__main__":
    create_project_memory_api() 
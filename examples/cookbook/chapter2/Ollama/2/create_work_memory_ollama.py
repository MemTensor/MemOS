# create_work_memory_ollama.py
# 🎯 创建工作记忆的示例 (Ollama版)
import os

from dotenv import load_dotenv

from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


def create_work_memory_ollama():
    """
    🎯 创建工作记忆的示例 (Ollama版)
    """

    print("🚀 开始创建工作记忆 (Ollama版)...")

    # 加载环境变量
    load_dotenv()

    # 检查Ollama配置
    ollama_base_url = os.getenv("OLLAMA_BASE_URL")
    ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
    ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")

    if not ollama_base_url or not ollama_chat_model or not ollama_embed_model:
        raise ValueError(
            "❌ 未配置Ollama环境变量。请在.env文件中配置OLLAMA_BASE_URL、OLLAMA_CHAT_MODEL、OLLAMA_EMBED_MODEL。"
        )

    print("✅ 检测到Ollama本地模型模式")

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
        tags=["任务", "今日"],
    )

    # 创建记忆项
    work_memory = TextualMemoryItem(
        memory="今天需要完成代码审查、团队会议、以及准备明天的演示", metadata=work_metadata
    )

    print(f"工作记忆: {work_memory.memory}")
    print(f"记忆类型: {work_memory.metadata.memory_type}")
    print("🎯 配置模式: OLLAMA")
    print(f"🤖 聊天模型: {ollama_chat_model}")
    print(f"🔍 嵌入模型: {ollama_embed_model}")

    return work_memory


if __name__ == "__main__":
    create_work_memory_ollama()

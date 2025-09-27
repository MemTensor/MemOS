# create_memcube_with_memreader_api.py
# 🎯 使用MemReader创建MemCube的完整流程 (API版)
import os
import uuid

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.mem_cube.general import GeneralMemCube
from memos.mem_reader.factory import MemReaderFactory


# 加载环境变量
load_dotenv()

# 获取OpenAI配置
openai_key = os.getenv("OPENAI_API_KEY")
openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

if not openai_key:
    raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")

print("✅ 检测到OpenAI API模式")

# 获取MemOS配置
user_id = os.getenv("MOS_USER_ID", "default_user")
top_k = int(os.getenv("MOS_TOP_K", "5"))

# 获取模型配置
chat_model = os.getenv("OPENAI_API_CHAT_MODEL", "gpt-4o-mini")
embed_model = os.getenv("OPENAI_API_EMBED_MODEL", "text-embedding-3-small")


def create_memcube_with_memreader():
    """
    🎯 使用MemReader创建MemCube的完整流程 (API版)
    """

    print("🔧 创建MemCube配置...")

    print(f"🤖 使用聊天模型: {chat_model}")
    print(f"🔍 使用嵌入模型: {embed_model}")

    # OpenAI模式配置
    cube_config = {
        "user_id": user_id,
        "cube_id": f"{user_id}_company_handbook_cube",
        "text_mem": {
            "backend": "general_text",
            "config": {
                "extractor_llm": {
                    "backend": "openai",
                    "config": {
                        "model_name_or_path": chat_model,
                        "temperature": 0.8,
                        "max_tokens": 8192,
                        "top_p": 0.9,
                        "top_k": 50,
                        "api_key": openai_key,
                        "api_base": openai_base,
                    },
                },
                "embedder": {
                    "backend": "universal_api",
                    "config": {
                        "provider": "openai",
                        "api_key": openai_key,
                        "model_name_or_path": embed_model,
                        "base_url": openai_base,
                    },
                },
                "vector_db": {
                    "backend": "qdrant",
                    "config": {
                        "collection_name": f"{user_id}_company_handbook",
                        "vector_dimension": 1536,
                        "distance_metric": "cosine",
                    },
                },
            },
        },
        "act_mem": {"backend": "uninitialized"},
        "para_mem": {"backend": "uninitialized"},
    }

    # 创建MemCube实例
    config_obj = GeneralMemCubeConfig.model_validate(cube_config)
    mem_cube = GeneralMemCube(config_obj)

    print("✅ MemCube创建成功！")
    print(f"  📊 用户ID: {mem_cube.config.user_id}")
    print(f"  📊 MemCube ID: {mem_cube.config.cube_id}")
    print(f"  📊 文本记忆后端: {mem_cube.config.text_mem.backend}")
    print(f"  🔍 嵌入模型: {embed_model} (OpenAI)")
    print("  🎯 配置模式: OPENAI API")

    return mem_cube


def create_memreader_config():
    """
    🎯 创建MemReader配置
    """

    # 加载环境变量
    load_dotenv()

    # 获取OpenAI配置
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

    # 获取模型配置
    chat_model = os.getenv("OPENAI_API_CHAT_MODEL", "gpt-4o-mini")
    embed_model = os.getenv("OPENAI_API_EMBED_MODEL", "text-embedding-3-small")

    # MemReader配置
    mem_reader_config = MemReaderConfigFactory(
        backend="simple_struct",
        config={
            "llm": {
                "backend": "openai",
                "config": {
                    "model_name_or_path": chat_model,
                    "temperature": 0.8,
                    "max_tokens": 8192,
                    "top_p": 0.9,
                    "top_k": 50,
                    "api_key": openai_key,
                    "api_base": openai_base,
                },
            },
            "embedder": {
                "backend": "universal_api",
                "config": {
                    "provider": "openai",
                    "api_key": openai_key,
                    "model_name_or_path": embed_model,
                    "base_url": openai_base,
                },
            },
            "chunker": {
                "backend": "sentence",
                "config": {"chunk_size": 64, "chunk_overlap": 20, "min_sentences_per_chunk": 1},
            },
            "remove_prompt_example": False,
        },
    )

    return mem_reader_config


def load_document_to_memcube(mem_cube, doc_path):
    """
    🎯 使用MemReader加载文档到MemCube
    """

    print(f"\n📖 使用MemReader读取文档: {doc_path}")

    # 创建MemReader
    mem_reader_config = create_memreader_config()
    mem_reader = MemReaderFactory.from_config(mem_reader_config)

    # 准备文档数据
    print("📄 准备文档数据...")
    documents = [doc_path]  # MemReader期望的是文档路径列表

    # 使用MemReader处理文档
    print("🧠 使用MemReader提取记忆...")
    memories = mem_reader.get_memory(
        documents,
        type="doc",
        info={"user_id": mem_cube.config.user_id, "session_id": str(uuid.uuid4())},
    )

    print(f"📚 MemReader生成了 {len(memories)} 个记忆片段")

    # 添加记忆到MemCube
    print("💾 添加记忆到MemCube...")
    for mem in memories:
        mem_cube.text_mem.add(mem)

    print(f"✅ 成功添加 {len(memories)} 个记忆片段到MemCube")

    # 输出基本信息
    print("\n📊 MemCube基本信息:")
    print(f"  📁 文档来源: {doc_path}")
    print(f"  📝 记忆片段数量: {len(memories)}")
    print("  🏷️ 文档类型: company_handbook")
    print("  💾 向量数据库: Qdrant (内存模式，释放内存即删除)")
    print(f"  🔍 嵌入模型: {embed_model} (OpenAI)")
    print("  🎯 配置模式: OPENAI API")
    print("  🧠 记忆提取器: MemReader (simple_struct)")

    return mem_cube


if __name__ == "__main__":
    print("🚀 开始使用MemReader创建文档MemCube (API版)...")

    # 创建MemCube
    mem_cube = create_memcube_with_memreader()

    # 加载文档
    import os

    current_dir = os.path.dirname(os.path.abspath(__file__))
    doc_path = os.path.join(current_dir, "company_handbook.txt")
    load_document_to_memcube(mem_cube, doc_path)

    print("\n🎉 MemCube创建完成！")

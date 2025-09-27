# create_memcube_with_memreader_ollama.py
# 🎯 使用MemReader创建MemCube的完整流程 (Ollama版)
import os
import uuid

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.mem_cube.general import GeneralMemCube
from memos.mem_reader.factory import MemReaderFactory


def create_memcube_with_memreader():
    """
    🎯 使用MemReader创建MemCube的完整流程 (Ollama版)
    """

    print("🔧 创建MemCube配置...")

    # 加载环境变量
    load_dotenv()

    # 获取Ollama配置
    ollama_base_url = os.getenv("OLLAMA_BASE_URL")
    ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
    ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")

    if not ollama_base_url or not ollama_chat_model or not ollama_embed_model:
        raise ValueError(
            "❌ 未配置Ollama环境变量。请在.env文件中配置OLLAMA_BASE_URL、OLLAMA_CHAT_MODEL、OLLAMA_EMBED_MODEL。"
        )

    print("✅ 检测到Ollama本地模型模式")

    # 获取MemOS配置
    user_id = os.getenv("MOS_USER_ID", "default_user")
    top_k = int(os.getenv("MOS_TOP_K", "5"))

    # Ollama模式配置
    cube_config = {
        "user_id": user_id,
        "cube_id": f"{user_id}_company_handbook_cube",
        "text_mem": {
            "backend": "general_text",
            "config": {
                "extractor_llm": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": ollama_chat_model,
                        "api_base": ollama_base_url,
                    },
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": ollama_embed_model,
                        "api_base": ollama_base_url,
                    },
                },
                "vector_db": {
                    "backend": "qdrant",
                    "config": {
                        "collection_name": f"{user_id}_company_handbook",
                        "vector_dimension": 768,
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
    print(f"  🔍 嵌入模型: {ollama_embed_model} (Ollama)")
    print("  🎯 配置模式: OLLAMA")

    return mem_cube


def create_memreader_config():
    """
    🎯 创建MemReader配置 (Ollama版)
    """

    # 加载环境变量
    load_dotenv()

    # 获取Ollama配置
    ollama_base_url = os.getenv("OLLAMA_BASE_URL")
    ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
    ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")

    # MemReader配置
    mem_reader_config = MemReaderConfigFactory(
        backend="simple_struct",
        config={
            "llm": {
                "backend": "ollama",
                "config": {"model_name_or_path": ollama_chat_model, "api_base": ollama_base_url},
            },
            "embedder": {
                "backend": "ollama",
                "config": {"model_name_or_path": ollama_embed_model, "api_base": ollama_base_url},
            },
            "chunker": {
                "backend": "sentence",
                "config": {"chunk_size": 128, "chunk_overlap": 32, "min_sentences_per_chunk": 1},
            },
            "remove_prompt_example": False,
        },
    )

    return mem_reader_config


def load_document_to_memcube(mem_cube, doc_path):
    """
    🎯 使用MemReader加载文档到MemCube (Ollama版)
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
        print(mem)

    print(f"✅ 成功添加 {len(memories)} 个记忆片段到MemCube")

    # 输出基本信息
    print("\n📊 MemCube基本信息:")
    print(f"  📁 文档来源: {doc_path}")
    print(f"  📝 记忆片段数量: {len(memories)}")
    print("  🏷️ 文档类型: company_handbook")
    print("  💾 向量数据库: Qdrant (内存模式，释放内存即删除)")
    print(f"  🔍 嵌入模型: {os.getenv('OLLAMA_EMBED_MODEL')} (Ollama)")
    print("  🎯 配置模式: OLLAMA")
    print("  🧠 记忆提取器: MemReader (simple_struct)")

    return mem_cube


if __name__ == "__main__":
    print("🚀 开始使用MemReader创建文档MemCube (Ollama版)...")

    # 创建MemCube
    mem_cube = create_memcube_with_memreader()

    # 加载文档
    import os

    current_dir = os.path.dirname(os.path.abspath(__file__))
    doc_path = os.path.join(current_dir, "company_handbook.txt")
    load_document_to_memcube(mem_cube, doc_path)

    print("\n🎉 MemCube创建完成！")

# test_memcube_search_and_chat_ollama.py
# 🎯 测试MemCube的搜索和对话功能 (Ollama版)
import os
from dotenv import load_dotenv
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS

def create_mos_config():
    """
    🎯 创建MOS配置 (Ollama版)
    """
    load_dotenv()
    
    user_id = os.getenv("MOS_USER_ID", "default_user")
    top_k = int(os.getenv("MOS_TOP_K", "5"))
    ollama_base_url = os.getenv("OLLAMA_BASE_URL")
    ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
    ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")
    
    if not ollama_base_url or not ollama_chat_model or not ollama_embed_model:
        raise ValueError("❌ 未配置Ollama环境变量。请在.env文件中配置OLLAMA_BASE_URL、OLLAMA_CHAT_MODEL、OLLAMA_EMBED_MODEL。")
    
    # Ollama模式配置
    return MOSConfig(
        user_id=user_id,
        chat_model={
            "backend": "ollama",
            "config": {
                "model_name_or_path": ollama_chat_model,
                "api_base": ollama_base_url,
                "temperature": 0.1,
                "max_tokens": 1024,
            }
        },
        mem_reader={
            "backend": "simple_struct",
            "config": {
                "llm": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": ollama_chat_model,
                        "api_base": ollama_base_url,
                    }
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": ollama_embed_model,
                        "api_base": ollama_base_url,
                    }
                },
                "chunker": {
                    "backend": "sentence",
                    "config": {
                        "tokenizer_or_token_counter": "gpt2",
                        "chunk_size": 512,
                        "chunk_overlap": 128,
                        "min_sentences_per_chunk": 1,
                    }
                }
            }
        },
        enable_textual_memory=True,
        top_k=top_k
    )

def test_memcube_search_and_chat():
    """
    🎯 测试MemCube的搜索和对话功能 (Ollama版)
    """
    
    print("🚀 开始测试MemCube搜索和对话功能 (Ollama版)...")
    
    # 导入步骤2的函数
    from create_memcube_with_memreader_ollama import create_memcube_with_memreader, load_document_to_memcube
    
    # 创建MemCube并加载文档
    print("\n1️⃣ 创建MemCube并加载文档...")
    mem_cube = create_memcube_with_memreader()
    # 加载文档
    import os
    current_dir = os.path.dirname(os.path.abspath(__file__))
    doc_path = os.path.join(current_dir, "company_handbook.txt")
    load_document_to_memcube(mem_cube, doc_path)
    
    # 创建MOS配置
    print("\n2️⃣ 创建MOS配置...")
    mos_config = create_mos_config()
    
    # 创建MOS实例并注册MemCube
    print("3️⃣ 创建MOS实例并注册MemCube...")
    mos = MOS(mos_config)
    mos.register_mem_cube(mem_cube, mem_cube_id="handbook")
    
    print("✅ MOS实例创建成功！")
    print(f"  📊 用户ID: {mos.user_id}")
    print(f"  📊 会话ID: {mos.session_id}")
    print(f"  📊 注册的MemCube: {list(mos.mem_cubes.keys())}")
    print(f"  🎯 配置模式: OLLAMA")
    print(f"  🤖 聊天模型: {os.getenv('OLLAMA_CHAT_MODEL')} (Ollama)")
    print(f"  🔍 嵌入模型: {os.getenv('OLLAMA_EMBED_MODEL')} (Ollama)")
    
    # 测试搜索功能
    print("\n🔍 测试搜索功能...")
    test_queries = [
        "公司的工作时间是什么？",
        "年假有多少天？",
        "有什么福利待遇？",
        "如何联系HR部门？"
    ]
    
    for query in test_queries:
        print(f"\n❓ 查询: {query}")
        
        # 使用MOS搜索
        search_results = mos.search(query, top_k=2)
        
        if search_results and search_results.get("text_mem"):
            print(f"📋 找到 {len(search_results['text_mem'])} 个相关结果:")
            for cube_result in search_results['text_mem']:
                cube_id = cube_result['cube_id']
                memories = cube_result['memories']
                print(f"  📦 MemCube: {cube_id}")
                for i, memory in enumerate(memories[:2], 1):  # 只显示前2个结果
                    print(f"    {i}. {memory.memory[:100]}...")
        else:
            print("😓 未找到相关结果")
    
    # 测试对话功能
    print("\n💬 测试对话功能...")
    chat_questions = [
        "公司的工作时间安排是怎样的？",
        "员工可以享受哪些福利？",
        "如何联系IT支持部门？"
    ]
    
    for question in chat_questions:
        print(f"\n👤 问题: {question}")
        
        try:
            response = mos.chat(question)
            print(f"🤖 回答: {response}")
        except Exception as e:
            print(f"❌ 对话失败: {e}")
    
    print("\n🎉 测试完成！")
    return mos

if __name__ == "__main__":
    test_memcube_search_and_chat() 
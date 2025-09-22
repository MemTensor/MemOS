# test_memos_setup_ollama_mode.py
# 🎯 Ollama模式验证脚本 - 使用本地Ollama模型和手动配置
import os
import sys

from dotenv import load_dotenv


def check_ollama_environment():
    """🎯 检查Ollama环境变量配置"""
    print("🔍 检查Ollama环境变量配置...")

    # 加载.env文件
    load_dotenv()

    # 检查Ollama配置
    ollama_base_url = os.getenv("OLLAMA_BASE_URL")
    ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
    ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")

    print("📋 Ollama环境变量状态:")

    if ollama_base_url:
        print(f"  ✅ OLLAMA_BASE_URL: {ollama_base_url}")
        print(f"  ✅ OLLAMA_CHAT_MODEL: {ollama_chat_model or '❌ 未配置'}")
        print(f"  ✅ OLLAMA_EMBED_MODEL: {ollama_embed_model or '❌ 未配置'}")
        ollama_configured = bool(ollama_base_url and ollama_chat_model and ollama_embed_model)

        if ollama_configured:
            print("✅ Ollama配置完整")
        else:
            print("❌ Ollama配置不完整")

        return ollama_configured
    else:
        print("  ❌ OLLAMA_BASE_URL: 未配置")
        print("  ❌ OLLAMA_CHAT_MODEL: 未配置")
        print("  ❌ OLLAMA_EMBED_MODEL: 未配置")
        return False


def check_memos_installation():
    """🎯 检查MemOS安装状态"""
    print("\n🔍 检查MemOS安装状态...")

    try:
        import memos

        print(f"✅ MemOS版本: {memos.__version__}")

        # 测试核心组件导入
        from memos.configs.mem_cube import GeneralMemCubeConfig
        from memos.configs.mem_os import MOSConfig
        from memos.mem_cube.general import GeneralMemCube
        from memos.mem_os.main import MOS

        print("✅ 核心组件导入成功")
        return True

    except ImportError as e:
        print(f"❌ 导入失败: {e}")
        return False
    except Exception as e:
        print(f"❌ 其他错误: {e}")
        return False


def test_ollama_functionality():
    """🎯 测试Ollama模式功能"""
    print("\n🔍 测试Ollama模式功能...")

    try:
        from memos.configs.mem_cube import GeneralMemCubeConfig
        from memos.configs.mem_os import MOSConfig
        from memos.mem_cube.general import GeneralMemCube
        from memos.mem_os.main import MOS

        # 获取环境变量
        ollama_base_url = os.getenv("OLLAMA_BASE_URL")
        ollama_chat_model = os.getenv("OLLAMA_CHAT_MODEL")
        ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL")

        print("🚀 创建Ollama配置...")

        # 创建MOS配置
        mos_config = MOSConfig(
            user_id=os.getenv("MOS_USER_ID", "default_user"),
            chat_model={
                "backend": "ollama",
                "config": {
                    "model_name_or_path": ollama_chat_model,
                    "api_base": ollama_base_url,
                    "temperature": 0.7,
                    "max_tokens": 1024,
                },
            },
            mem_reader={
                "backend": "simple_struct",
                "config": {
                    "llm": {
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
                    "chunker": {
                        "backend": "sentence",
                        "config": {
                            "tokenizer_or_token_counter": "gpt2",
                            "chunk_size": 512,
                            "chunk_overlap": 128,
                            "min_sentences_per_chunk": 1,
                        },
                    },
                },
            },
            enable_textual_memory=True,
            top_k=int(os.getenv("MOS_TOP_K", "5")),
        )

        # 创建MemCube配置
        cube_config = GeneralMemCubeConfig(
            user_id=os.getenv("MOS_USER_ID", "default_user"),
            cube_id=f"{os.getenv('MOS_USER_ID', 'default_user')}_cube",
            text_mem={
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
                            "collection_name": f"{os.getenv('MOS_USER_ID', 'default_user')}_collection",
                            "vector_dimension": 768,  # nomic-embed-text的维度
                            "distance_metric": "cosine",
                        },
                    },
                },
            },
            act_mem={"backend": "uninitialized"},
            para_mem={"backend": "uninitialized"},
        )

        print("✅ 配置创建成功！")

        # 创建MOS实例和MemCube
        print("🚀 创建MOS实例和MemCube...")
        memory = MOS(mos_config)
        mem_cube = GeneralMemCube(cube_config)
        memory.register_mem_cube(mem_cube)

        print("✅ MOS实例和MemCube创建成功！")
        print(f"  📊 用户ID: {memory.user_id}")
        print(f"  📊 会话ID: {memory.session_id}")
        print(f"  📊 MemCube ID: {mem_cube.config.cube_id}")

        # 测试添加记忆
        print("\n🧠 测试添加记忆...")
        memory.add(memory_content="这是一个Ollama模式的测试记忆")
        print("✅ 记忆添加成功！")

        # 测试聊天功能
        print("\n💬 测试聊天功能...")
        response = memory.chat("我刚才添加了什么记忆？")
        print(f"✅ 聊天响应: {response}")

        # 测试搜索功能
        print("\n🔍 测试搜索功能...")
        search_results = memory.search("测试记忆", top_k=3)
        if search_results and search_results.get("text_mem"):
            print(f"✅ 搜索成功，找到 {len(search_results['text_mem'])} 个结果")
        else:
            print("⚠️ 搜索未返回结果")

        # 测试MemCube直接操作
        print("\n🔧 测试MemCube直接操作...")
        mem_cube.text_mem.add(
            [
                {
                    "memory": "这是通过MemCube直接添加的记忆",
                    "metadata": {"source": "conversation", "type": "fact", "confidence": 0.9},
                }
            ]
        )
        print("✅ MemCube直接操作成功！")

        print("✅ Ollama模式功能测试成功！")
        return True

    except Exception as e:
        print(f"❌ Ollama模式功能测试失败: {e}")
        print("💡 提示：请检查Ollama服务是否运行，模型是否已下载。")
        return False


def main():
    """🎯 Ollama模式主验证流程"""
    print("🚀 开始MemOS Ollama模式环境验证...\n")

    # 步骤1: 检查Ollama环境变量
    env_ok = check_ollama_environment()

    # 步骤2: 检查安装状态
    install_ok = check_memos_installation()

    # 步骤3: 测试功能
    if env_ok and install_ok:
        func_ok = test_ollama_functionality()
    else:
        func_ok = False
        if not env_ok:
            print("\n⚠️ 由于Ollama环境变量配置不完整，跳过功能测试")
        elif not install_ok:
            print("\n⚠️ 由于MemOS安装失败，跳过功能测试")

    # 总结
    print("\n" + "=" * 50)
    print("📊 Ollama模式验证结果总结:")
    print(f"  Ollama环境变量: {'✅ 通过' if env_ok else '❌ 失败'}")
    print(f"  MemOS安装: {'✅ 通过' if install_ok else '❌ 失败'}")
    print(f"  功能测试: {'✅ 通过' if func_ok else '❌ 失败'}")

    if env_ok and install_ok and func_ok:
        print("\n🎉 恭喜！MemOS Ollama模式环境配置完全成功！")
        print("💡 你现在可以开始使用MemOS Ollama模式了。")
        print("💡 使用方式: 手动配置MOSConfig和GeneralMemCubeConfig")
    elif install_ok and env_ok:
        print("\n⚠️ MemOS已安装，Ollama已配置，但功能测试失败。")
        print("💡 请检查Ollama服务是否运行，模型是否已下载。")
    elif install_ok:
        print("\n⚠️ MemOS已安装，但需要配置Ollama环境变量才能正常使用。")
        print("💡 请在.env文件中配置OLLAMA_BASE_URL、OLLAMA_CHAT_MODEL、OLLAMA_EMBED_MODEL。")
    else:
        print("\n❌ 环境配置存在问题，请检查上述错误信息。")

    return bool(env_ok and install_ok and func_ok)


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)

# test_memos_setup_api_mode.py
# 🎯 API模式验证脚本 - 使用OpenAI API和MOS.simple()
import os
import sys
from dotenv import load_dotenv

def check_openai_environment():
    """🎯 检查OpenAI环境变量配置"""
    print("🔍 检查OpenAI环境变量配置...")
    
    # 加载.env文件
    load_dotenv()
    
    # 检查OpenAI配置
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    
    print(f"📋 OpenAI环境变量状态:")
    
    if openai_key:
        masked_key = openai_key[:8] + "..." + openai_key[-4:] if len(openai_key) > 12 else "***"
        print(f"  ✅ OPENAI_API_KEY: {masked_key}")
        print(f"  ✅ OPENAI_API_BASE: {openai_base}")
        return True
    else:
        print(f"  ❌ OPENAI_API_KEY: 未配置")
        print(f"  ❌ OPENAI_API_BASE: {openai_base}")
        return False

def check_memos_installation():
    """🎯 检查MemOS安装状态"""
    print("\n🔍 检查MemOS安装状态...")
    
    try:
        import memos
        print(f"✅ MemOS版本: {memos.__version__}")
        
        # 测试核心组件导入
        from memos.mem_cube.general import GeneralMemCube
        from memos.mem_os.main import MOS
        from memos.configs.mem_os import MOSConfig
        
        print("✅ 核心组件导入成功")
        return True
        
    except ImportError as e:
        print(f"❌ 导入失败: {e}")
        return False
    except Exception as e:
        print(f"❌ 其他错误: {e}")
        return False

def test_api_functionality():
    """🎯 测试API模式功能"""
    print("\n🔍 测试API模式功能...")
    
    try:
        from memos.mem_os.main import MOS
        
        # 加载环境变量获取模型配置
        load_dotenv()
        chat_model = os.getenv("OPENAI_API_CHAT_MODEL", "gpt-4o-mini")
        embed_model = os.getenv("OPENAI_API_EMBED_MODEL", "text-embedding-3-small")
        
        print(f"🤖 使用聊天模型: {chat_model}")
        print(f"🔍 使用嵌入模型: {embed_model}")
        
        # 使用默认的MOS.simple()方法
        print("🚀 创建MOS实例（使用MOS.simple()）...")
        memory = MOS.simple()
        
        print("✅ MOS.simple() 创建成功！")
        print(f"  📊 用户ID: {memory.user_id}")
        print(f"  📊 会话ID: {memory.session_id}")
        
        # 测试添加记忆
        print("\n🧠 测试添加记忆...")
        memory.add(memory_content="这是一个API模式的测试记忆")
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
        
        print("✅ API模式功能测试成功！")
        return True
        
    except Exception as e:
        print(f"❌ API模式功能测试失败: {e}")
        print("💡 提示：请检查OpenAI API密钥和网络连接。")
        return False

def main():
    """🎯 API模式主验证流程"""
    print("🚀 开始MemOS API模式环境验证...\n")
    
    # 步骤1: 检查OpenAI环境变量
    env_ok = check_openai_environment()
    
    # 步骤2: 检查安装状态
    install_ok = check_memos_installation()
    
    # 步骤3: 测试功能
    if env_ok and install_ok:
        func_ok = test_api_functionality()
    else:
        func_ok = False
        if not env_ok:
            print("\n⚠️ 由于OpenAI环境变量配置不完整，跳过功能测试")
        elif not install_ok:
            print("\n⚠️ 由于MemOS安装失败，跳过功能测试")
    
    # 总结
    print("\n" + "="*50)
    print("📊 API模式验证结果总结:")
    print(f"  OpenAI环境变量: {'✅ 通过' if env_ok else '❌ 失败'}")
    print(f"  MemOS安装: {'✅ 通过' if install_ok else '❌ 失败'}")
    print(f"  功能测试: {'✅ 通过' if func_ok else '❌ 失败'}")
    
    if env_ok and install_ok and func_ok:
        print(f"\n🎉 恭喜！MemOS API模式环境配置完全成功！")
        print(f"💡 你现在可以开始使用MemOS API模式了。")
    elif install_ok and env_ok:
        print(f"\n⚠️ MemOS已安装，OpenAI已配置，但功能测试失败。")
        print(f"💡 请检查OpenAI API密钥是否有效，网络连接是否正常。")
    elif install_ok:
        print("\n⚠️ MemOS已安装，但需要配置OpenAI环境变量才能正常使用。")
        print("💡 请在.env文件中配置OPENAI_API_KEY。")
    else:
        print("\n❌ 环境配置存在问题，请检查上述错误信息。")
    
    return bool(env_ok and install_ok and func_ok)

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1) 
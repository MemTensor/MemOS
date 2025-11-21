"""
DeepSearch Agent 与 API 组件集成示例

本示例展示如何直接使用 API 服务器初始化的组件来创建 DeepSearch Agent。
这种方式可以避免重复初始化，直接复用已有的组件。

适用场景：
- 在已有的 API 服务器中添加 DeepSearch 功能
- 使用统一的组件配置
- 避免重复初始化开销
"""

import os
import sys

# 确保可以导入 memos 模块
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from memos.api.handlers.component_init import init_server
from memos.configs.mem_agent import DeepSearchAgentConfig
from memos.mem_agent.deepsearch_agent import DeepSearchMemAgent
from memos.log import get_logger

logger = get_logger(__name__)


def create_deepsearch_from_api_components():
    """
    从 API 服务器组件创建 DeepSearch Agent
    
    这个函数演示了如何：
    1. 使用 init_server() 初始化所有组件
    2. 提取需要的组件（llm 和 naive_mem_cube）
    3. 创建 DeepSearch Agent
    """
    logger.info("="*60)
    logger.info("使用 API 组件初始化 DeepSearch Agent")
    logger.info("="*60 + "\n")
    
    # 步骤 1: 初始化所有服务器组件
    # 这会创建 llm, naive_mem_cube, scheduler 等所有组件
    logger.info("1. 初始化服务器组件...")
    components = init_server()
    logger.info("   ✓ 服务器组件初始化完成")
    
    # 步骤 2: 提取需要的组件
    logger.info("\n2. 提取必需组件...")
    llm = components["llm"]
    naive_mem_cube = components["naive_mem_cube"]
    logger.info(f"   ✓ LLM: {type(llm).__name__}")
    logger.info(f"   ✓ MemCube: {type(naive_mem_cube).__name__}")
    logger.info(f"   ✓ TextMemory: {type(naive_mem_cube.text_mem).__name__}")
    
    # 步骤 3: 创建 DeepSearch Agent 配置
    logger.info("\n3. 创建 DeepSearch Agent...")
    config = DeepSearchAgentConfig(
        agent_name="APIDeepSearchAgent",
        description="基于 API 组件的深度搜索代理",
        max_iterations=3,
        timeout=60,
    )
    
    # 步骤 4: 初始化 DeepSearch Agent
    # memory_retriever 使用 naive_mem_cube.text_mem
    # 它提供了 search() 方法用于检索记忆
    deep_search_agent = DeepSearchMemAgent(
        llm=llm,
        memory_retriever=naive_mem_cube.text_mem,
        config=config
    )
    
    logger.info(f"   ✓ DeepSearch Agent 创建成功")
    logger.info(f"   ✓ Agent 名称: {config.agent_name}")
    logger.info(f"   ✓ 最大迭代次数: {config.max_iterations}")
    
    return deep_search_agent, components


def demo_usage(deep_search_agent, components):
    """
    演示如何使用 DeepSearch Agent
    """
    logger.info("\n" + "="*60)
    logger.info("DeepSearch Agent 使用演示")
    logger.info("="*60 + "\n")
    
    naive_mem_cube = components["naive_mem_cube"]
    text_mem = naive_mem_cube.text_mem
    
    # 添加一些测试记忆
    logger.info("1. 添加测试记忆...")
    test_data = [
        "MemOS 是一个先进的记忆操作系统，专门为 AI 系统设计。",
        "MemOS 支持多种记忆类型：文本记忆、偏好记忆、行为记忆等。",
        "DeepSearch Agent 是 MemOS 中的一个重要组件，用于深度搜索和信息检索。",
    ]
    
    for i, content in enumerate(test_data, 1):
        try:
            text_mem.add(
                user_name="demo_user",
                messages=[content],
                source="demo"
            )
            logger.info(f"   ✓ 记忆 {i}: {content[:40]}...")
        except Exception as e:
            logger.warning(f"   ✗ 添加记忆失败: {e}")
    
    # 执行深度搜索
    logger.info("\n2. 执行深度搜索...")
    query = "MemOS 支持哪些功能？"
    logger.info(f"   查询: {query}")
    
    try:
        response = deep_search_agent.run(
            query=query,
            user_id="demo_user",
            history=[]
        )
        
        logger.info("\n3. 搜索结果:")
        logger.info("-" * 60)
        logger.info(response)
        logger.info("-" * 60)
        
        return response
        
    except Exception as e:
        logger.error(f"   ✗ 搜索失败: {e}")
        import traceback
        traceback.print_exc()
        return None


def integrate_with_api_router():
    """
    展示如何将 DeepSearch Agent 集成到 API Router 中
    
    这段代码展示了在 server_router.py 中如何添加一个新的端点
    来使用 DeepSearch Agent。
    """
    logger.info("\n" + "="*60)
    logger.info("API Router 集成示例")
    logger.info("="*60 + "\n")
    
    logger.info("在 server_router.py 中添加以下代码：\n")
    
    integration_code = '''
# 在 server_router.py 顶部导入
from memos.configs.mem_agent import DeepSearchAgentConfig
from memos.mem_agent.deepsearch_agent import DeepSearchMemAgent

# 在初始化 handlers 之后，创建 DeepSearch Agent
deep_search_agent = DeepSearchMemAgent(
    llm=llm,
    memory_retriever=naive_mem_cube.text_mem,
    config=DeepSearchAgentConfig(
        agent_name="APIDeepSearchAgent",
        max_iterations=3,
        timeout=60,
    )
)

# 添加新的 API 端点
@router.post("/deepsearch", summary="Deep search with memory")
def deep_search(
    user_id: str,
    query: str,
    history: list[str] = None
):
    """Execute deep search with iterative memory retrieval."""
    try:
        response = deep_search_agent.run(
            query=query,
            user_id=user_id,
            history=history or []
        )
        return {"status": "success", "response": response}
    except Exception as e:
        return {"status": "error", "message": str(e)}
'''
    
    print(integration_code)


def main():
    """主函数"""
    logger.info("DeepSearch Agent 与 API 组件集成示例\n")
    
    # 检查环境变量
    required_env_vars = ["OPENAI_API_KEY"]
    missing_vars = [var for var in required_env_vars if not os.getenv(var)]
    
    if missing_vars:
        logger.error(f"❌ 缺少必要的环境变量: {', '.join(missing_vars)}")
        logger.error("\n请设置以下环境变量：")
        logger.error("  export OPENAI_API_KEY='your-api-key'")
        logger.error("  export OPENAI_BASE_URL='your-base-url'  # 可选")
        return
    
    try:
        # 创建 DeepSearch Agent
        agent, components = create_deepsearch_from_api_components()
        
        # 演示使用
        demo_usage(agent, components)
        
        # 展示集成方法
        integrate_with_api_router()
        
        logger.info("\n" + "="*60)
        logger.info("示例运行完成！")
        logger.info("="*60)
        
    except Exception as e:
        logger.error(f"\n❌ 运行失败: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()


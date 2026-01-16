import json
import os
import sys


# 添加项目根目录到 python path,确保可以导入 src 下的模块
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../src")))


def init_components():
    """
    初始化 MemOS 核心组件。

    此函数负责构建并配置 MemOS 运行所需的所有基础组件,包括:
    1. LLM (Large Language Model): 负责处理自然语言理解和生成的模型(如 GPT-4o)。
    2. Embedder: 负责将文本转换为向量表示,用于语义搜索和相似度计算。
    3. GraphDB (Neo4j): 图数据库,用于持久化存储记忆节点及其关系。
    4. MemoryManager: 记忆管理器,负责记忆的增删改查操作。
    5. MemReader: 记忆读取器,用于解析和处理输入文本。
    6. Reranker: 重排序器,用于对检索结果进行精细化排序。
    7. Searcher: 搜索器,整合了检索和重排序逻辑。
    8. FeedbackServer (SimpleMemFeedback): 反馈服务核心,负责处理用户反馈并更新记忆。

    Returns:
        tuple: (feedback_server, memory_manager, embedder)
    """
    # 延迟导入,避免 E402(模块级 import 不在顶部)
    from memos.configs.embedder import EmbedderConfigFactory
    from memos.configs.graph_db import GraphDBConfigFactory
    from memos.configs.llm import LLMConfigFactory
    from memos.configs.mem_reader import MemReaderConfigFactory
    from memos.configs.reranker import RerankerConfigFactory
    from memos.embedders.factory import EmbedderFactory
    from memos.graph_dbs.factory import GraphStoreFactory
    from memos.llms.factory import LLMFactory
    from memos.mem_feedback.simple_feedback import SimpleMemFeedback
    from memos.mem_reader.factory import MemReaderFactory
    from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
    from memos.reranker.factory import RerankerFactory

    print("Initializing MemOS Components...")

    # 1. LLM: 配置大语言模型,这里使用 OpenAI 兼容接口
    llm_config = LLMConfigFactory.model_validate(
        {
            "backend": "openai",
            "config": {
                "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                "temperature": 0.8,
                "max_tokens": 1024,
                "top_p": 0.9,
                "top_k": 50,
                "api_key": os.getenv("OPENAI_API_KEY"),
                "api_base": os.getenv("OPENAI_API_BASE"),
            },
        }
    )
    llm = LLMFactory.from_config(llm_config)

    # 2. Embedder: 配置嵌入模型,用于生成文本向量
    embedder_config = EmbedderConfigFactory.model_validate(
        {
            "backend": os.getenv("MOS_EMBEDDER_BACKEND", "universal_api"),
            "config": {
                "provider": "openai",
                "api_key": os.getenv("MOS_EMBEDDER_API_KEY", "EMPTY"),
                "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "bge-m3"),
                "base_url": os.getenv("MOS_EMBEDDER_API_BASE"),
            },
        }
    )
    embedder = EmbedderFactory.from_config(embedder_config)

    # 3. GraphDB: 配置 Neo4j 图数据库连接
    graph_db = GraphStoreFactory.from_config(
        GraphDBConfigFactory.model_validate(
            {
                "backend": "neo4j",
                "config": {
                    "uri": os.getenv("NEO4J_URI", "neo4j://127.0.0.1:7687"),
                    "user": os.getenv("NEO4J_USER", "neo4j"),
                    "password": os.getenv("NEO4J_PASSWORD", "12345678"),
                    "db_name": os.getenv("NEO4J_DB_NAME", "neo4j"),
                    "user_name": "zhs",
                    "auto_create": True,
                    "use_multi_db": False,
                    "embedding_dimension": int(os.getenv("EMBEDDING_DIMENSION", "1024")),
                },
            }
        )
    )

    # 清空特定用户的测试数据,确保每次运行环境干净
    graph_db.clear(user_name="cube_id_001_0115")

    # 4. MemoryManager: 记忆管理核心,协调存储和检索
    memory_manager = MemoryManager(graph_db, embedder, llm, is_reorganize=False)

    # 5. MemReader: 配置记忆读取器,包含分块策略
    mem_reader = MemReaderFactory.from_config(
        MemReaderConfigFactory.model_validate(
            {
                "backend": "simple_struct",
                "config": {
                    "llm": llm_config.model_dump(),
                    "embedder": embedder_config.model_dump(),
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
            }
        )
    )

    # 6. Reranker: 配置重排序器,提升检索相关性
    mem_reranker = RerankerFactory.from_config(
        RerankerConfigFactory.model_validate(
            {
                "backend": os.getenv("MOS_RERANKER_BACKEND", "cosine_local"),
                "config": {
                    "level_weights": {"topic": 1.0, "concept": 1.0, "fact": 1.0},
                    "level_field": "background",
                },
            }
        )
    )

    # 7. Searcher: 综合检索器
    searcher = Searcher(llm, graph_db, embedder, mem_reranker)

    # 8. Feedback Server: 初始化反馈服务,这是本示例的核心
    feedback_server = SimpleMemFeedback(
        llm=llm,
        embedder=embedder,
        graph_store=graph_db,
        memory_manager=memory_manager,
        mem_reader=mem_reader,
        searcher=searcher,
        reranker=mem_reranker,
        pref_mem=None,
    )

    return feedback_server, memory_manager, embedder


def main():
    """
    主程序流程:
    1. 初始化组件。
    2. 模拟一个对话场景和已有的(可能错误的)记忆。
    3. 接收用户反馈(纠正记忆)。
    4. 处理反馈并更新记忆库。
    5. 展示处理结果。
    """
    # dotenv 放到 main 里加载,避免影响模块导入顺序
    from dotenv import load_dotenv

    load_dotenv()

    # 延迟导入,避免 E402
    from memos.mem_feedback.utils import make_mem_item

    feedback_server, memory_manager, embedder = init_components()
    print("-" * 50)
    print("Initialization Done. Processing Feedback...")
    print("-" * 50)

    # 1. 模拟对话历史 (History)
    # 这里模拟了一段用户和助手的对话,其中助手的回答包含了一个关于用户偏好的陈述。
    history = [
        {"role": "user", "content": "我喜欢什么水果,不喜欢什么水果"},
        {"role": "assistant", "content": "你喜欢苹果,不喜欢香蕉"},
    ]

    # 2. 模拟初始记忆 (Initial Memory)
    # 我们先手动向数据库中添加一条记忆,代表系统当前认为的“事实”。
    # 这条记忆内容为 "你喜欢苹果,不喜欢香蕉",随后我们将通过反馈来纠正它。
    mem_text = "你喜欢苹果,不喜欢香蕉"
    memory_manager.add(
        [
            make_mem_item(
                mem_text,
                user_id="user_id_001",
                user_name="cube_id_001_0115",
                session_id="session_id",
                tags=["fact"],
                key="food_preference",
                sources=[{"type": "chat"}],
                background="init from chat history",
                embedding=embedder.embed([mem_text])[0],  # 需要生成向量以便后续检索
                info={
                    "user_id": "user_id_001",
                    "user_name": "cube_id_001_0115",
                    "session_id": "session_id",
                },
            )
        ],
        user_name="cube_id_001_0115",
        mode="sync",
    )

    # 3. 输入反馈 (Feedback Input)
    # 用户指出之前的记忆有误,并提供了正确的信息。
    feedback_content = "错了,实际上我喜欢的是山竹"

    print("\n对话历史 (History):")
    print(json.dumps(history, ensure_ascii=False, indent=2))
    print("\n输入反馈 (Feedback Input):")
    print(feedback_content)

    # 4. 处理反馈 (Process Feedback)
    # 核心步骤:调用 feedback_server 处理用户的纠正信息。
    # 系统会分析反馈内容,检索相关记忆,并生成更新操作(如新增,修改或归档旧记忆)。
    res = feedback_server.process_feedback(
        user_id="user_id_001",
        user_name="cube_id_001_0115",
        session_id="session_id",
        chat_history=history,
        feedback_content=feedback_content,
        feedback_time="",
        async_mode="sync",
        corrected_answer="",
        task_id="task_id",
        info={},
    )

    # 5. 反馈结果 (Feedback Result)
    print("\n" + "=" * 50)
    print("反馈结果 (Feedback Result)")
    print("=" * 50)

    """
    打印反馈处理的返回结果,包含新增或更新的记忆操作 (add/update)
    """
    print(json.dumps(res, ensure_ascii=False, indent=4, default=str))


if __name__ == "__main__":
    main()

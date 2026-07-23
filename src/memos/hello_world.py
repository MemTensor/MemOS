from memos import log


logger = log.get_logger(__name__)


def memos_hello_world() -> str:
    logger.info("memos_hello_world function called.")
    return "Hello world from memos!"


def memos_chend_hello_world() -> str:
    logger.info("memos_chend_hello_world function called.")
    return "Hello world from memos-chend!"


def memos_wanghy_hello_world() -> str:
    logger.info("memos_wanghy_hello_world function called.")
    return "Hello world from memos-wanghy!"


def memos_niusm_hello_world() -> str:
    logger.info("memos_niusm_hello_world function called.")
    return "Hello world from memos-niusm!"


def memos_huojh_hello_world(arr: list) -> list:
    logger.info("memos_huojh_hello_world function called.")
    if len(arr) <= 1:
        return arr
    else:
        pivot = arr[0]
        left = [x for x in arr[1:] if x < pivot]
        right = [x for x in arr[1:] if x >= pivot]
        return [*memos_huojh_hello_world(left), pivot, *memos_huojh_hello_world(right)]


def memos_dany_hello_world(para_1: int, para_2: str) -> str:
    logger.info(f"logger.info: para_1 is {para_1}")
    logger.debug(f"logger.debug: para_2 is {para_2}")
    return f"return_value_{para_1}"


def memos_wangyzh_hello_world() -> str:
    logger.info("memos_wangyzh_hello_world function called.")
    return "Hello world from memos-wangyzh!"


def memos_zhaojihao_hello_world() -> str:
    logger.info("memos_zhaojihao_hello_world function called.")
    return "Hello world from memos-zhaojihao!"


def memos_yuqingchen_hello_world() -> str:
    logger.info("memos_yuqingchen_hello_world function called.")
    return "Hello world from memos-yuqingchen!"


def memos_chentang_hello_world(user_id: str = "locomo_exp_user_1", version: str = "default"):
    import os

    from memos.configs.memory import MemoryConfigFactory
    from memos.memories.factory import MemoryFactory

    config = MemoryConfigFactory(
        backend="general_text",
        config={
            "extractor_llm": {
                "backend": "openai",
                "config": {
                    "model_name_or_path": os.getenv("MODEL"),
                    "temperature": 0,
                    "max_tokens": 8192,
                    "api_key": os.getenv("OPENAI_API_KEY"),
                    "api_base": os.environ.get("OPENAI_API_BASE") or "https://api.openai.com/v1",
                },
            },
            "vector_db": {
                "backend": "qdrant",
                "config": {
                    "path": f"outputs/locomo/memos-{version}/storages/{user_id}/qdrant",
                    "collection_name": "test_textual_memory",
                    "distance_metric": "cosine",
                    "vector_dimension": 768,  # nomic-embed-text model's embedding dimension is 768
                },
            },
            "embedder": {
                "backend": "ollama",
                "config": {
                    "model_name_or_path": os.getenv("EMBEDDING_MODEL"),
                },
            },
        },
    )
    memory = MemoryFactory.from_config(config)

    return memory

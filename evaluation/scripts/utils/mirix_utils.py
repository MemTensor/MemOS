import os

import yaml

from tqdm import tqdm


def get_mirix_client(config_path, load_from=None):
    if os.path.exists(os.path.expanduser("~/.mirix")):
        os.system("rm -rf ~/.mirix/*")

    with open(config_path) as f:
        agent_config = yaml.safe_load(f)

    os.environ["OPENAI_API_KEY"] = agent_config["api_key"]
    import mirix

    from mirix import EmbeddingConfig, LLMConfig, Mirix

    embedding_default_config = EmbeddingConfig(
        embedding_model=agent_config["embedding_model_name"],
        embedding_endpoint_type="openai",
        embedding_endpoint=agent_config["model_endpoint"],
        embedding_dim=1536,
        embedding_chunk_size=8191,
    )

    llm_default_config = LLMConfig(
        model=agent_config["model_name"],
        model_endpoint_type="openai",
        model_endpoint=agent_config["model_endpoint"],
        api_key=agent_config["api_key"],
        model_wrapper=None,
        context_window=128000,
    )

    def embedding_default_config_func(cls, model_name=None, provider=None):
        return embedding_default_config

    def llm_default_config_func(cls, model_name=None, provider=None):
        return llm_default_config

    mirix.EmbeddingConfig.default_config = embedding_default_config_func
    mirix.LLMConfig.default_config = llm_default_config_func

    assistant = Mirix(
        api_key=agent_config["api_key"],
        config_path=config_path,
        model=agent_config["model_name"],
        load_from=load_from,
    )
    return assistant


if __name__ == "__main__":
    config_path = "configs-example/mirix_config.yaml"
    out_dir = "results/mirix-test"

    assistant = get_mirix_client(config_path)

    chunks = [
        "I prefer coffee over tea",
        "My work hours are 9 AM to 5 PM",
        "Important meeting with client on Friday at 2 PM",
    ]

    for _idx, chunk in tqdm(enumerate(chunks), total=len(chunks)):
        response = assistant.add(chunk)

    assistant.save(out_dir)

    assistant = get_mirix_client(config_path, load_from=out_dir)
    response = assistant.chat("What's my schedule like this week?")

    print(response)
    assistant.create_user(user_name="user1")
    assistant.create_user(user_name="user2")
    user1 = assistant.get_user_by_name(user_name="user1")
    user2 = assistant.get_user_by_name(user_name="user2")
    assistant.add("i prefer tea over coffee", user_id=user1.id)
    assistant.add("my favourite drink is coke", user_id=user2.id)
    response1 = assistant.chat("What drink do I prefer?", user_id=user1.id)
    response2 = assistant.chat("What drink do I prefer?", user_id=user2.id)
    print(response1, response2)

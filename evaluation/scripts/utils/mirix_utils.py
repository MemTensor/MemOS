import os
import json
import mirix
import yaml
from mirix import Mirix, EmbeddingConfig, LLMConfig
from tqdm import tqdm


def get_mirix_client(config_path):
    if os.path.exists(os.path.expanduser(f"~/.mirix")):
        os.system(f"rm -rf ~/.mirix/*")

    with open(config_path, "r") as f:
        agent_config = yaml.safe_load(f)

    embedding_default_config = EmbeddingConfig(
        embedding_model=agent_config['embedding_model_name'],
        embedding_endpoint_type="openai",
        embedding_endpoint=agent_config['model_endpoint'],
        embedding_dim=1536,
        embedding_chunk_size=8191,
    )

    llm_default_config = LLMConfig(
        model=agent_config['model_name'],
        model_endpoint_type="openai",
        model_endpoint=agent_config['model_endpoint'],
        api_key=agent_config['api_key'],
        model_wrapper=None,
        context_window=128000,
    )

    def embedding_default_config_func(cls, model_name=None, provider=None):
        return embedding_default_config

    def llm_default_config_func(cls, model_name=None, provider=None):
        return llm_default_config

    mirix.EmbeddingConfig.default_config = embedding_default_config_func
    mirix.LLMConfig.default_config = llm_default_config_func

    assistant = Mirix(api_key=agent_config['api_key'], config_path=config_path, model=agent_config['model_name'])
    return assistant


if __name__ == '__main__':
    config_path = '/Users/wuhao/PycharmProjects/MemOS/evaluation/configs/mirix_config.yaml'
    out_dir = '/Users/wuhao/PycharmProjects/MemOS/evaluation/results/mirix'

    assistant = get_mirix_client(config_path)

    chunks = [
        "I prefer coffee over tea",
        "My work hours are 9 AM to 5 PM",
        "Important meeting with client on Friday at 2 PM"
    ]

    for idx, chunk in tqdm(enumerate(chunks), total=len(chunks)):
        response = assistant.add(chunk)

    response = assistant.chat("What's my schedule like this week?")

    print(response)
    assistant.get_user_by_name()
    user1 = assistant.create_user(user_name='user1')
    assistant.add('i prefer tea over coffee', user_id=user1.id)
    response = assistant.chat("What drink do I prefer?", user_id=user1.id)



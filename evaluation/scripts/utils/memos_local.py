import os

from memos import GeneralMemCubeConfig, GeneralMemCube, MOSConfig
from memos.mem_os.product import MOSProduct


def filter_memory_data(memories_data):
    filtered_data = {}
    for key, value in memories_data.items():
        if key == "text_mem":
            filtered_data[key] = []
            for mem_group in value:
                # Check if it's the new data structure (list of TextualMemoryItem objects)
                if "memories" in mem_group and isinstance(mem_group["memories"], list):
                    # New data structure: directly a list of TextualMemoryItem objects
                    filtered_memories = []
                    for memory_item in mem_group["memories"]:
                        # Create filtered dictionary
                        filtered_item = {
                            "id": memory_item.id,
                            "memory": memory_item.memory,
                            "metadata": {},
                        }
                        # Filter metadata, excluding embedding
                        if hasattr(memory_item, "metadata") and memory_item.metadata:
                            for attr_name in dir(memory_item.metadata):
                                if not attr_name.startswith("_") and attr_name != "embedding":
                                    attr_value = getattr(memory_item.metadata, attr_name)
                                    if not callable(attr_value):
                                        filtered_item["metadata"][attr_name] = attr_value
                        filtered_memories.append(filtered_item)

                    filtered_group = {
                        "cube_id": mem_group.get("cube_id", ""),
                        "memories": filtered_memories,
                    }
                    filtered_data[key].append(filtered_group)
                else:
                    # Old data structure: dictionary with nodes and edges
                    filtered_group = {
                        "memories": {"nodes": [], "edges": mem_group["memories"].get("edges", [])}
                    }
                    for node in mem_group["memories"].get("nodes", []):
                        filtered_node = {
                            "id": node.get("id"),
                            "memory": node.get("memory"),
                            "metadata": {
                                k: v
                                for k, v in node.get("metadata", {}).items()
                                if k != "embedding"
                            },
                        }
                        filtered_group["memories"]["nodes"].append(filtered_node)
                    filtered_data[key].append(filtered_group)
        else:
            filtered_data[key] = value
    return filtered_data


def memos_client(
        mode="local",
        db_name=None,
        user_id=None,
        top_k=20,
        mem_cube_path="./",
        mem_cube_config_path="configs/lme_mem_cube_config.json",
        mem_os_config_path="configs/mos_memos_config.json",
        addorsearch="add",
):
    """Initialize and return a Memos client instance."""

    with open(mem_os_config_path) as f:
        mos_config_data = json.load(f)
    mos_config_data["top_k"] = top_k
    mos_config = MOSConfig(**mos_config_data)
    memos = MOSProduct(mos_config)
    memos.create_user(user_id=user_id)

    if addorsearch == "add":
        with open(mem_cube_config_path) as f:
            mem_cube_config_data = json.load(f)
        mem_cube_config_data["user_id"] = user_id
        mem_cube_config_data["cube_id"] = user_id
        mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["db_name"] = (
            f"{db_name.replace('_', '')}"
        )
        mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["user_name"] = user_id
        mem_cube_config_data["text_mem"]["config"]["reorganize"] = True
        mem_cube_config = GeneralMemCubeConfig.model_validate(mem_cube_config_data)
        mem_cube = GeneralMemCube(mem_cube_config)

    if not os.path.exists(mem_cube_path):
        mem_cube.dump(mem_cube_path)

    memos.user_register(
        user_id=user_id,
        user_name=user_id,
        interests=f"I'm {user_id}",
        default_mem_cube=mem_cube,
    )

    return memos


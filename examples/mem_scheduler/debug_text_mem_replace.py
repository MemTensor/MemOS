import json
import shutil
import sys

from pathlib import Path

from memos_w_scheduler_for_test import init_task

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.analyzer.mos_for_test_scheduler import MOSForTestScheduler


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

# Enable execution from any working directory

logger = get_logger(__name__)

if __name__ == "__main__":
    # set up data
    conversations, questions = init_task()

    # set configs
    mos_config = MOSConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_optimized_scheduler.yaml"
    )

    mem_cube_config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config_neo4j.yaml"
    )

    # default local graphdb uri
    if AuthConfig.default_config_exists():
        auth_config = AuthConfig.from_local_config()

        mos_config.mem_reader.config.llm.config.api_key = auth_config.openai.api_key
        mos_config.mem_reader.config.llm.config.api_base = auth_config.openai.base_url

        mem_cube_config.text_mem.config.graph_db.config.uri = auth_config.graph_db.uri
        mem_cube_config.text_mem.config.graph_db.config.user = auth_config.graph_db.user
        mem_cube_config.text_mem.config.graph_db.config.password = auth_config.graph_db.password
        mem_cube_config.text_mem.config.graph_db.config.db_name = auth_config.graph_db.db_name
        mem_cube_config.text_mem.config.graph_db.config.auto_create = (
            auth_config.graph_db.auto_create
        )

    # Initialization
    mos = MOSForTestScheduler(mos_config)

    user_id = "user_1"
    mos.create_user(user_id)

    mem_cube_id = "mem_cube_5"
    mem_cube_name_or_path = f"{BASE_DIR}/outputs/mem_scheduler/{user_id}/{mem_cube_id}"

    if Path(mem_cube_name_or_path).exists():
        shutil.rmtree(mem_cube_name_or_path)
        print(f"{mem_cube_name_or_path} is not empty, and has been removed.")

    mem_cube = GeneralMemCube(mem_cube_config)
    mem_cube.dump(mem_cube_name_or_path)
    mos.register_mem_cube(
        mem_cube_name_or_path=mem_cube_name_or_path, mem_cube_id=mem_cube_id, user_id=user_id
    )

    mos.add(conversations, user_id=user_id, mem_cube_id=mem_cube_id)

    # Add interfering conversations
    file_path = Path(f"{BASE_DIR}/examples/data/mem_scheduler/scene_data.json")
    scene_data = json.load(file_path.open("r", encoding="utf-8"))
    mos.add(scene_data[0], user_id=user_id, mem_cube_id=mem_cube_id)
    mos.add(scene_data[1], user_id=user_id, mem_cube_id=mem_cube_id)

    # Test the replace_working_memory functionality
    print("\n--- Testing replace_working_memory ---")

    # Get current working memories
    text_mem_base = mem_cube.text_mem
    if text_mem_base is not None:
        working_memories_before = text_mem_base.get_working_memory()
        print(f"Working memories before replacement: {len(working_memories_before)}")

        # Create filtered memories (simulate what the scheduler would do)
        # Keep only memories related to Max
        filtered_memories = [working_memories_before[1], working_memories_before[4]]

        text_mem_base.replace_working_memory(memories=filtered_memories)

        # Check working memory after replacement
        working_memories_after = text_mem_base.get_working_memory()
        print(f"Working memories after replacement: {len(working_memories_after)}")

        if len(working_memories_after) == len(filtered_memories):
            print("✅ SUCCESS: Working memory count matches filtered memories")
        else:
            print(
                f"❌ FAILED: Expected {len(filtered_memories)}, got {len(working_memories_after)}"
            )

    else:
        print("❌ text_mem is None - not properly initialized")

    mos.mem_scheduler.stop()

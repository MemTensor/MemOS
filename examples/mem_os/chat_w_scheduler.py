import shutil
import sys

from pathlib import Path

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


# set configs
mos_config = MOSConfig.from_yaml_file(
    f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml"
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
    mem_cube_config.text_mem.config.graph_db.config.auto_create = auth_config.graph_db.auto_create

# Initialization
mos = MOS(mos_config)

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

messages = [
    {"role": "user", "content": "I like playing football."},
    {"role": "assistant", "content": "I like playing football too."},
]
mos.add(messages, user_id=user_id, mem_cube_id=mem_cube_id)


while True:
    user_input = input("👤 [You] ").strip()
    print()
    response = mos.chat(user_input, user_id=user_id)
    retrieved_memories = mos.get_all(mem_cube_id=mem_cube_id, user_id=user_id)
    print(f"🤖 [Assistant] {response}\n")
    for node in retrieved_memories["text_mem"][0]["memories"]["nodes"]:
        if node["metadata"]["memory_type"] == "WorkingMemory":
            print(f"🤖 [Assistant]working mem : {node['memory']}\n")

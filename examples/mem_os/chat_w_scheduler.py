import shutil
import uuid

from pathlib import Path

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.utils.misc_utils import parse_yaml


# init MOS
config = parse_yaml("./examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml")

mos_config = MOSConfig(**config)
mos = MOS(mos_config)

# create user
user_id = str(uuid.uuid4())
mos.create_user(user_id=user_id)

config = GeneralMemCubeConfig.from_yaml_file(
    "./examples/data/config/mem_scheduler/mem_cube_config.yaml"
)
mem_cube_id = "mem_cube_5"
mem_cube_name_or_path = f"./outputs/mem_scheduler/{user_id}/{mem_cube_id}"
if Path(mem_cube_name_or_path).exists():
    shutil.rmtree(mem_cube_name_or_path)
    print(f"{mem_cube_name_or_path} is not empty, and has been removed.")

mem_cube = GeneralMemCube(config)
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
    if retrieved_memories["act_mem"][0]["memories"]:
        for act_mem in retrieved_memories["act_mem"][0]["memories"]:
            print(f"🤖 [Assistant]act_mem: {act_mem['memory']}\n")
    else:
        print("🤖 [Assistant]act_mem: None\n")

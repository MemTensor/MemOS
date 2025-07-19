import shutil
import sys

from datetime import datetime
from pathlib import Path

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig, SchedulerConfigFactory
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.modules.schemas import (
    ANSWER_LABEL,
    QUERY_LABEL,
    ScheduleMessageItem,
)
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_scheduler.utils import parse_yaml


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


def init_task():
    conversations = [
        {"role": "user", "content": "I just adopted a golden retriever puppy yesterday."},
        {"role": "assistant", "content": "Congratulations! What did you name your new puppy?"},
        {
            "role": "user",
            "content": "His name is Max. I live near Central Park in New York where we'll walk daily.",
        },
        {"role": "assistant", "content": "Max will love those walks! Any favorite treats for him?"},
        {
            "role": "user",
            "content": "He loves peanut butter biscuits. Personally, I'm allergic to nuts though.",
        },
        {"role": "assistant", "content": "Good to know about your allergy. I'll note that."},
        # Question 1 (Pet) - Name
        {"role": "user", "content": "What's my dog's name again?"},
        {"role": "assistant", "content": "Your dog is named Max."},
        # Question 2 (Pet) - Breed
        {"role": "user", "content": "Can you remind me what breed Max is?"},
        {"role": "assistant", "content": "Max is a golden retriever."},
        # Question 3 (Pet) - Treat
        {"role": "user", "content": "What treats does Max like?"},
        {"role": "assistant", "content": "He loves peanut butter biscuits."},
        # Question 4 (Address)
        {"role": "user", "content": "Where did I say I live?"},
        {"role": "assistant", "content": "You live near Central Park in New York."},
        # Question 5 (Allergy)
        {"role": "user", "content": "What food should I avoid due to allergy?"},
        {"role": "assistant", "content": "You're allergic to nuts."},
        {"role": "user", "content": "Perfect, just wanted to check what you remembered."},
        {"role": "assistant", "content": "Happy to help! Let me know if you need anything else."},
    ]

    questions = [
        {"question": "What's my dog's name again?", "category": "Pet"},
        {"question": "Can you remind me what breed Max is?", "category": "Pet"},
        {"question": "What treats does Max like?", "category": "Pet"},
        {"question": "Where did I say I live?", "category": "Address"},
        {"question": "What food should I avoid due to allergy?", "category": "Allergy"},
    ]
    return conversations, questions


def run_with_automatic_scheduler_init():
    print("==== run_with_automatic_scheduler_init ====")
    conversations, questions = init_task()

    config = parse_yaml(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_scheduler.yaml"
    )

    mos_config = MOSConfig(**config)
    mos = MOS(mos_config)

    user_id = "user_1"
    mos.create_user(user_id)

    config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config.yaml"
    )
    mem_cube_id = "mem_cube_5"
    mem_cube_name_or_path = f"{BASE_DIR}/outputs/mem_scheduler/{user_id}/{mem_cube_id}"
    if Path(mem_cube_name_or_path).exists():
        shutil.rmtree(mem_cube_name_or_path)
        print(f"{mem_cube_name_or_path} is not empty, and has been removed.")

    # default local graphdb uri
    if AuthConfig.default_config_exists():
        auth_config = AuthConfig.from_local_yaml()
        config.text_mem.config.graph_db.config.uri = auth_config.graph_db.uri

    mem_cube = GeneralMemCube(config)
    mem_cube.dump(mem_cube_name_or_path)
    mos.register_mem_cube(
        mem_cube_name_or_path=mem_cube_name_or_path, mem_cube_id=mem_cube_id, user_id=user_id
    )
    mos.add(conversations, user_id=user_id, mem_cube_id=mem_cube_id)

    for item in questions:
        query = item["question"]
        response = mos.chat(query, user_id=user_id)
        print(f"Query:\n {query}\n\nAnswer:\n {response}")

    mos.mem_scheduler.stop()


def run_with_manual_scheduler_init():
    print("==== run_with_manual_scheduler_init ====")
    conversations, questions = init_task()

    config = parse_yaml(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_wo_scheduler.yaml"
    )

    mos_config = MOSConfig(**config)
    mos = MOS(mos_config)

    user_id = "user_1"
    mos.create_user(user_id)

    config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config.yaml"
    )
    mem_cube_id = "mem_cube_5"
    mem_cube_name_or_path = f"{BASE_DIR}/outputs/mem_scheduler/{user_id}/{mem_cube_id}"
    if Path(mem_cube_name_or_path).exists():
        shutil.rmtree(mem_cube_name_or_path)
        print(f"{mem_cube_name_or_path} is not empty, and has been removed.")

    # default local graphdb uri
    if AuthConfig.default_config_exists():
        auth_config = AuthConfig.from_local_yaml()
        config.text_mem.config.graph_db.config.uri = auth_config.graph_db.uri

    mem_cube = GeneralMemCube(config)
    mem_cube.dump(mem_cube_name_or_path)
    mos.register_mem_cube(
        mem_cube_name_or_path=mem_cube_name_or_path, mem_cube_id=mem_cube_id, user_id=user_id
    )

    example_scheduler_config_path = (
        f"{BASE_DIR}/examples/data/config/mem_scheduler/general_scheduler_config.yaml"
    )
    scheduler_config = SchedulerConfigFactory.from_yaml_file(
        yaml_path=example_scheduler_config_path
    )
    mem_scheduler = SchedulerFactory.from_config(scheduler_config)
    mem_scheduler.initialize_modules(chat_llm=mos.chat_llm)

    mos.mem_scheduler = mem_scheduler

    mos.mem_scheduler.start()

    mos.add(conversations, user_id=user_id, mem_cube_id=mem_cube_id)

    for item in questions:
        query = item["question"]
        message_item = ScheduleMessageItem(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            label=QUERY_LABEL,
            mem_cube=mos.mem_cubes[mem_cube_id],
            content=query,
            timestamp=datetime.now(),
        )
        mos.mem_scheduler.submit_messages(messages=message_item)
        response = mos.chat(query, user_id=user_id)
        message_item = ScheduleMessageItem(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            label=ANSWER_LABEL,
            mem_cube=mos.mem_cubes[mem_cube_id],
            content=response,
            timestamp=datetime.now(),
        )
        mos.mem_scheduler.submit_messages(messages=message_item)
        print(f"Query:\n {query}\n\nAnswer:\n {response}")

    mos.mem_scheduler.stop()


if __name__ == "__main__":
    run_with_automatic_scheduler_init()

    run_with_manual_scheduler_init()

import asyncio
import sys

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from memos.configs.mem_scheduler import SchedulerConfigFactory
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import QUERY_TASK_LABEL


if TYPE_CHECKING:
    from memos.mem_scheduler.general_scheduler import GeneralScheduler


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


def service_run():
    # Init
    example_scheduler_config_path = (
        f"{BASE_DIR}/examples/data/config/mem_scheduler/general_scheduler_config.yaml"
    )
    scheduler_config = SchedulerConfigFactory.from_yaml_file(
        yaml_path=example_scheduler_config_path
    )
    mem_scheduler: GeneralScheduler = SchedulerFactory.from_config(scheduler_config)

    # Simulate writing test data
    questions = [
        {"question": "What's my dog's name again?", "category": "Pet"},
        {"question": "Can you remind me what breed Max is?", "category": "Pet"},
        {"question": "What treats does Max like?", "category": "Pet"},
        {"question": "Where did I say I live?", "category": "Address"},
        {"question": "What food should I avoid due to allergy?", "category": "Allergy"},
    ]
    init_mem_cube = f"{BASE_DIR}/examples/data/mem_cube_2"
    print("Loading MemChatCube...")
    mem_cube = GeneralMemCube.init_from_dir(init_mem_cube)

    user_id = str(uuid4)

    mem_scheduler.initialize_redis()

    mem_scheduler.redis_start_listening()

    for item in questions:
        query = item["question"]
        message_item = ScheduleMessageItem(
            user_id=user_id,
            mem_cube_id="mem_cube_2",
            label=QUERY_TASK_LABEL,
            mem_cube=mem_cube,
            content=query,
            timestamp=datetime.now(),
        )
        res = mem_scheduler.redis_add_message_stream(message=message_item.to_dict())
        print(
            f"Added: {res}",
        )
        asyncio.sleep(0.5)

    mem_scheduler.redis_stop_listening()

    mem_scheduler.redis_close()


if __name__ == "__main__":
    service_run()

import shutil
import sys

from pathlib import Path
from queue import Queue
from typing import TYPE_CHECKING

from tqdm import tqdm

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.analyzer.mos_for_test_scheduler import MOSForTestScheduler
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    NOT_APPLICABLE_TYPE,
)


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas import (
        ScheduleLogForWebItem,
    )


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


def init_task():
    conversations = [
        {
            "role": "user",
            "content": "I have two dogs - Max (golden retriever) and Bella (pug). We live in Seattle.",
        },
        {"role": "assistant", "content": "Great! Any special care for them?"},
        {
            "role": "user",
            "content": "Max needs joint supplements. Actually, we're moving to Chicago next month.",
        },
        {
            "role": "user",
            "content": "Correction: Bella is 6, not 5. And she's allergic to chicken.",
        },
        {
            "role": "user",
            "content": "My partner's cat Whiskers visits weekends. Bella chases her sometimes.",
        },
    ]

    questions = [
        # 1. Basic factual recall (simple)
        {
            "question": "What breed is Max?",
            "category": "Pet",
            "expected": "golden retriever",
            "difficulty": "easy",
        },
        # 2. Temporal context (medium)
        {
            "question": "Where will I live next month?",
            "category": "Location",
            "expected": "Chicago",
            "difficulty": "medium",
        },
        # 3. Information correction (hard)
        {
            "question": "How old is Bella really?",
            "category": "Pet",
            "expected": "6",
            "difficulty": "hard",
            "hint": "User corrected the age later",
        },
        # 4. Relationship inference (harder)
        {
            "question": "Why might Whiskers be nervous around my pets?",
            "category": "Behavior",
            "expected": "Bella chases her sometimes",
            "difficulty": "harder",
        },
        # 5. Combined medical info (hardest)
        {
            "question": "Which pets have health considerations?",
            "category": "Health",
            "expected": "Max needs joint supplements, Bella is allergic to chicken",
            "difficulty": "hardest",
            "requires": ["combining multiple facts", "ignoring outdated info"],
        },
    ]
    return conversations, questions


def show_web_logs(mem_scheduler: GeneralScheduler):
    """Display all web log entries from the scheduler's log queue.

    Args:
        mem_scheduler: The scheduler instance containing web logs to display
    """
    if mem_scheduler._web_log_message_queue.empty():
        print("Web log queue is currently empty.")
        return

    print("\n" + "=" * 50 + " WEB LOGS " + "=" * 50)

    # Create a temporary queue to preserve the original queue contents
    temp_queue = Queue()
    log_count = 0

    while not mem_scheduler._web_log_message_queue.empty():
        log_item: ScheduleLogForWebItem = mem_scheduler._web_log_message_queue.get()
        temp_queue.put(log_item)
        log_count += 1

        # Print log entry details
        print(f"\nLog Entry #{log_count}:")
        print(f'- "{log_item.label}" log: {log_item}')

        print("-" * 50)

    # Restore items back to the original queue
    while not temp_queue.empty():
        mem_scheduler._web_log_message_queue.put(temp_queue.get())

    print(f"\nTotal {log_count} web log entries displayed.")
    print("=" * 110 + "\n")


if __name__ == "__main__":
    # set up data
    conversations, questions = init_task()

    # set configs
    mos_config = MOSConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_scheduler_and_openai.yaml"
    )

    mem_cube_config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config.yaml"
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

    for item in tqdm(questions, desc="processing queries"):
        query = item["question"]

        # test process_session_turn
        working_memory, new_candidates = mos.mem_scheduler.process_session_turn(
            queries=[query],
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            top_k=10,
        )
        print(f"\nnew_candidates: {[one.memory for one in new_candidates]}")

        # test activation memory update
        mos.mem_scheduler.update_activation_memory_periodically(
            interval_seconds=0,
            label=NOT_APPLICABLE_TYPE,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
        )

    show_web_logs(mos.mem_scheduler)

    mos.mem_scheduler.stop()

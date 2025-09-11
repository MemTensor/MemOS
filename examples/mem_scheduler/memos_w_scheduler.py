import shutil
import sys

from pathlib import Path
from queue import Queue
from typing import TYPE_CHECKING

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.general_scheduler import GeneralScheduler


if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import (
        ScheduleLogForWebItem,
    )


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


def run_with_scheduler_init():
    print("==== run_with_automatic_scheduler_init ====")
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

    mos.add(conversations, user_id=user_id, mem_cube_id=mem_cube_id)

    for item in questions:
        print("===== Chat Start =====")
        query = item["question"]
        print(f"Query:\n {query}\n")
        response = mos.chat(query=query, user_id=user_id)
        print(f"Answer:\n {response}\n")

    show_web_logs(mem_scheduler=mos.mem_scheduler)

    mos.mem_scheduler.stop()


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
    run_with_scheduler_init()

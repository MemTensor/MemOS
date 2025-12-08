import sys

from pathlib import Path
from queue import Queue
from typing import TYPE_CHECKING

from tqdm import tqdm

from memos.api.routers.server_router import (
    mem_scheduler,
)
from memos.log import get_logger
from memos.mem_scheduler.analyzer.api_analyzer import DirectSearchMemoriesAnalyzer
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import MEM_UPDATE_TASK_LABEL


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


def show_web_logs(mem_scheduler: BaseScheduler):
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


class ScheduleModulesRunner(DirectSearchMemoriesAnalyzer):
    def __init__(self):
        super().__init__()

    def start_conversation(self, user_id="test_user", mem_cube_id="test_cube", session_id=None):
        self.current_user_id = user_id
        self.current_mem_cube_id = mem_cube_id
        self.current_session_id = (
            session_id or f"session_{hash(user_id + mem_cube_id)}_{len(self.conversation_history)}"
        )
        self.conversation_history = []

        logger.info(f"Started conversation session: {self.current_session_id}")
        print(f"🚀 Started new conversation session: {self.current_session_id}")
        print(f"   User ID: {self.current_user_id}")
        print(f"   Mem Cube ID: {self.current_mem_cube_id}")

    def add_msgs(self, messages: list[dict]):
        # Create add request
        add_req = self.create_test_add_request(
            user_id=self.current_user_id,
            mem_cube_id=self.current_mem_cube_id,
            messages=messages,
            session_id=self.current_session_id,
        )

        # Add to memory
        result = self.add_memories(add_req)
        print(f"   ✅ Added to memory successfully: \n{messages}")

        return result


if __name__ == "__main__":
    # set up data
    conversations, questions = init_task()

    trying_modules = ScheduleModulesRunner()

    trying_modules.start_conversation(
        user_id="try_scheduler_modules",
        mem_cube_id="try_scheduler_modules",
    )

    trying_modules.add_msgs(
        messages=conversations,
    )

    mem_scheduler: OptimizedScheduler = mem_scheduler
    # Force retrieval to trigger every turn for the example to be deterministic
    try:
        mem_scheduler.monitor.query_trigger_interval = 0.0
    except Exception:
        logger.exception("Failed to set query_trigger_interval; continuing with defaults.")

    for item_idx, item in enumerate(tqdm(questions, desc="processing queries")):
        query = item["question"]
        messages_to_send = [
            ScheduleMessageItem(
                item_id=f"test_item_{item_idx}",
                user_id=trying_modules.current_user_id,
                mem_cube_id=trying_modules.current_mem_cube_id,
                label=MEM_UPDATE_TASK_LABEL,
                content=query,
            )
        ]

        # Run one session turn manually to get search candidates
        mem_scheduler._memory_update_consumer(
            messages=messages_to_send,
        )

    # Show accumulated web logs
    show_web_logs(mem_scheduler)

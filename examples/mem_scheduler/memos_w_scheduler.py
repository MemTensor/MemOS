import re
import shutil
import sys

from datetime import datetime
from pathlib import Path

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.schemas.message_schemas import ScheduleLogForWebItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    MEM_ARCHIVE_TASK_LABEL,
    MEM_ORGANIZE_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)
from memos.mem_scheduler.utils.filter_utils import transform_name_to_key


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


def _truncate_with_rules(text: str) -> str:
    has_cjk = bool(re.search(r"[\u4e00-\u9fff]", text))
    limit = 32 if has_cjk else 64
    normalized = text.strip().replace("\n", " ")
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "..."


def _format_title(ts: datetime, title_text: str) -> str:
    return f"{ts.astimezone().strftime('%H:%M:%S')} {title_text}"


def _cube_display_from(mem_cube_id: str) -> str:
    if "public" in (mem_cube_id or "").lower():
        return "PublicMemCube"
    return "UserMemCube"


_TYPE_SHORT = {
    "LongTermMemory": "LTM",
    "UserMemory": "User",
    "WorkingMemory": "Working",
    "ActivationMemory": "Activation",
    "ParameterMemory": "Parameter",
    "TextMemory": "Text",
    "UserInput": "Input",
    "NotApplicable": "NA",
}


def _format_entry(item: ScheduleLogForWebItem) -> tuple[str, str]:
    cube_display = getattr(item, "memcube_name", None) or _cube_display_from(item.mem_cube_id)
    label = item.label
    content = item.log_content or ""
    memcube_content = getattr(item, "memcube_log_content", None) or []
    memory_len = getattr(item, "memory_len", None) or len(memcube_content) or 1

    def _first_content() -> str:
        if memcube_content:
            return memcube_content[0].get("content", "") or content
        return content

    if label in ("addMessage", QUERY_TASK_LABEL, ANSWER_TASK_LABEL):
        target_cube = cube_display.replace("MemCube", "")
        title = _format_title(item.timestamp, f"addMessages to {target_cube} MemCube")
        return title, _truncate_with_rules(_first_content())

    if label in ("addMemory", ADD_TASK_LABEL):
        title = _format_title(item.timestamp, f"{cube_display} added {memory_len} memories")
        return title, _truncate_with_rules(_first_content())

    if label in ("updateMemory", MEM_UPDATE_TASK_LABEL):
        title = _format_title(item.timestamp, f"{cube_display} updated {memory_len} memories")
        return title, _truncate_with_rules(_first_content())

    if label in ("archiveMemory", MEM_ARCHIVE_TASK_LABEL):
        title = _format_title(item.timestamp, f"{cube_display} archived {memory_len} memories")
        return title, _truncate_with_rules(_first_content())

    if label in ("mergeMemory", MEM_ORGANIZE_TASK_LABEL):
        title = _format_title(item.timestamp, f"{cube_display} merged {memory_len} memories")
        merged = [c for c in memcube_content if c.get("type") == "merged"]
        post = [c for c in memcube_content if c.get("type") == "postMerge"]
        parts = []
        if merged:
            parts.append("Merged: " + " | ".join(c.get("content", "") for c in merged))
        if post:
            parts.append("Result: " + " | ".join(c.get("content", "") for c in post))
        detail = " ".join(parts) if parts else _first_content()
        return title, _truncate_with_rules(detail)

    if label == "scheduleMemory":
        title = _format_title(item.timestamp, f"{cube_display} scheduled {memory_len} memories")
        if memcube_content:
            return title, _truncate_with_rules(memcube_content[0].get("content", ""))
        key = transform_name_to_key(content)
        from_short = _TYPE_SHORT.get(item.from_memory_type, item.from_memory_type)
        to_short = _TYPE_SHORT.get(item.to_memory_type, item.to_memory_type)
        return title, _truncate_with_rules(f"[{from_short}→{to_short}] {key}: {content}")

    title = _format_title(item.timestamp, f"{cube_display} event")
    return title, _truncate_with_rules(_first_content())


def run_with_scheduler_init():
    print("==== run_with_automatic_scheduler_init ====")
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
    mos.mem_scheduler.current_mem_cube = mem_cube

    for item in questions:
        print("===== Chat Start =====")
        query = item["question"]
        print(f"Query:\n {query}\n")
        response = mos.chat(query=query, user_id=user_id)
        print(f"Answer:\n {response}\n")

    mos.mem_scheduler.stop()


if __name__ == "__main__":
    run_with_scheduler_init()

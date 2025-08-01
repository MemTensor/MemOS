from pathlib import Path
from typing import NewType


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent

QUERY_LABEL = "query"
ANSWER_LABEL = "answer"
ADD_LABEL = "add"

TreeTextMemory_SEARCH_METHOD = "tree_text_memory_search"
TreeTextMemory_FINE_SEARCH_METHOD = "tree_text_memory_fine_search"
TextMemory_SEARCH_METHOD = "text_memory_search"
DIRECT_EXCHANGE_TYPE = "direct"
FANOUT_EXCHANGE_TYPE = "fanout"
DEFAULT_WORKING_MEM_MONITOR_SIZE_LIMIT = 20
DEFAULT_ACTIVATION_MEM_MONITOR_SIZE_LIMIT = 5
DEFAULT_ACT_MEM_DUMP_PATH = f"{BASE_DIR}/outputs/mem_scheduler/mem_cube_scheduler_test.kv_cache"
DEFAULT_THREAD__POOL_MAX_WORKERS = 5
DEFAULT_CONSUME_INTERVAL_SECONDS = 3
NOT_INITIALIZED = -1


# web log
LONG_TERM_MEMORY_TYPE = "LongTermMemory"
USER_MEMORY_TYPE = "UserMemory"
WORKING_MEMORY_TYPE = "WorkingMemory"
TEXT_MEMORY_TYPE = "TextMemory"
ACTIVATION_MEMORY_TYPE = "ActivationMemory"
PARAMETER_MEMORY_TYPE = "ParameterMemory"
USER_INPUT_TYPE = "UserInput"
NOT_APPLICABLE_TYPE = "NotApplicable"

# monitors
MONITOR_WORKING_MEMORY_TYPE = "MonitorWorkingMemoryType"
MONITOR_ACTIVATION_MEMORY_TYPE = "MonitorActivationMemoryType"
DEFAULT_MAX_QUERY_KEY_WORDS = 1000
DEFAULT_WEIGHT_VECTOR_FOR_RANKING = [0.9, 0.05, 0.05]


# new types
UserID = NewType("UserID", str)
MemCubeID = NewType("CubeID", str)

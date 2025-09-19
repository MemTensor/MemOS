import sys

from pathlib import Path

from memos.log import get_logger


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


ZEP_MODEL = "zep"
MEM0_MODEL = "mem0"
MEM0_GRAPH_MODEL = "mem0_graph"
MEMOS_MODEL = "memos"
MEMOS_SCHEDULER_MODEL = "memos_scheduler"

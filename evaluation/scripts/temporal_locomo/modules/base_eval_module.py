import json
import os
import traceback

from collections import defaultdict
from pathlib import Path
from threading import Lock

import pandas as pd

from dotenv import load_dotenv

from memos.configs.mem_scheduler import AuthConfig
from memos.log import get_logger

from .constants import (
    BASE_DIR,
)
from .prompts import (
    CUSTOM_INSTRUCTIONS,
)


logger = get_logger(__name__)


class BaseEvalModule:
    def __init__(self, args):
        # hyper-parameters
        self.args = args
        self.frame = self.args.frame
        self.version = self.args.version
        self.workers = self.args.workers
        self.top_k = self.args.top_k

        # attributes
        self.custom_instructions = CUSTOM_INSTRUCTIONS
        self.data_dir = Path(f"{BASE_DIR}/data")
        self.locomo_df = pd.read_json(f"{self.data_dir}/locomo/locomo10.json")

        # Load temporal_locomo dataset if it exists
        self.temporal_locomo_data = None
        temporal_locomo_file = self.data_dir / "temporal_locomo" / "temporal_locomo_qa.json"
        if temporal_locomo_file.exists():
            with open(temporal_locomo_file, encoding="utf-8") as f:
                self.temporal_locomo_data = json.load(f)
            logger.info(
                f"Loaded temporal_locomo dataset with {len(self.temporal_locomo_data)} conversations"
            )
        else:
            logger.warning(f"Temporal locomo dataset not found at {temporal_locomo_file}")
        self.result_dir = Path(f"{BASE_DIR}/results/temporal_locomo/{self.frame}-{self.version}/")
        self.result_dir.mkdir(parents=True, exist_ok=True)

        self.search_path = self.result_dir / f"{self.frame}_locomo_search_results.json"
        self.response_path = self.result_dir / Path(f"{self.frame}_locomo_responses.json")
        self.ingestion_storage_dir = self.result_dir / "storages"
        self.mos_config_path = Path(f"{BASE_DIR}/configs-example/mos_w_scheduler_config.json")
        self.mem_cube_config_path = Path(f"{BASE_DIR}/configs-example/mem_cube_config.json")
        self.openai_api_key = os.getenv("CHAT_MODEL_API_KEY")
        self.openai_base_url = os.getenv("CHAT_MODEL_BASE_URL")
        self.openai_chat_model = os.getenv("CHAT_MODEL")

        auth_config_path = Path(f"{BASE_DIR}/scripts/temporal_locomo/eval_auth.json")
        if auth_config_path.exists():
            auth_config = AuthConfig.from_local_config(config_path=auth_config_path)

            self.mos_config_data = json.load(self.mos_config_path.open("r", encoding="utf-8"))
            self.mem_cube_config_data = json.load(
                self.mem_cube_config_path.open("r", encoding="utf-8")
            )

            # Update LLM authentication information in MOS configuration using dictionary assignment
            self.mos_config_data["mem_reader"]["config"]["llm"]["config"]["api_key"] = (
                auth_config.openai.api_key
            )
            self.mos_config_data["mem_reader"]["config"]["llm"]["config"]["api_base"] = (
                auth_config.openai.base_url
            )

            # Update graph database authentication information in memory cube configuration using dictionary assignment
            self.mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["uri"] = (
                auth_config.graph_db.uri
            )
            self.mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["user"] = (
                auth_config.graph_db.user
            )
            self.mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["password"] = (
                auth_config.graph_db.password
            )
            self.mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["db_name"] = (
                auth_config.graph_db.db_name
            )
            self.mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["auto_create"] = (
                auth_config.graph_db.auto_create
            )

            self.openai_api_key = auth_config.openai.api_key
            self.openai_base_url = auth_config.openai.base_url
            self.openai_chat_model = auth_config.openai.default_model
        else:
            print("Please referring to configs-example to provide valid configs.")
            exit()

        # Logger initialization
        self.logger = logger

        # Statistics tracking with thread safety
        self.stats = {self.frame: {self.version: defaultdict(dict)}}
        self.stats[self.frame][self.version]["response_stats"] = defaultdict(dict)
        self.stats[self.frame][self.version]["response_stats"]["response_failure"] = 0
        self.stats[self.frame][self.version]["response_stats"]["response_count"] = 0

        self.stats[self.frame][self.version]["memory_stats"] = defaultdict(dict)
        self.stats[self.frame][self.version]["memory_stats"]["total_queries"] = 0
        self.stats[self.frame][self.version]["memory_stats"]["can_answer_count"] = 0
        self.stats[self.frame][self.version]["memory_stats"]["cannot_answer_count"] = 0
        self.stats[self.frame][self.version]["memory_stats"]["answer_hit_rate"] = 0.0

        # Initialize memory history for tracking retrieval results
        self.stats_lock = Lock()
        self.scheduler_flag = True
        self.stats_dir = self.result_dir / "stats"
        self.stats_dir.mkdir(parents=True, exist_ok=True)  # Ensure the directory exists
        self.stats_path = self.stats_dir / "stats.txt"

        load_dotenv()

    def print_eval_info(self):
        """
        Calculate and print the evaluation information including answer statistics for memory scheduler (thread-safe).
        Shows total queries, can answer count, cannot answer count, and answer hit rate.
        """
        with self.stats_lock:
            # Get statistics
            total_queries = self.stats[self.frame][self.version]["memory_stats"]["total_queries"]
            can_answer_count = self.stats[self.frame][self.version]["memory_stats"][
                "can_answer_count"
            ]
            cannot_answer_count = self.stats[self.frame][self.version]["memory_stats"][
                "cannot_answer_count"
            ]
            hit_rate = self.stats[self.frame][self.version]["memory_stats"]["answer_hit_rate"]

            # Print basic statistics
            print(f"Total Queries: {total_queries}")
            logger.info(f"Total Queries: {total_queries}")

            print(f"Can Answer Count: {can_answer_count}")
            logger.info(f"Can Answer Count: {can_answer_count}")

            print(f"Cannot Answer Count: {cannot_answer_count}")
            logger.info(f"Cannot Answer Count: {cannot_answer_count}")

            # Verify count consistency
            if total_queries != (can_answer_count + cannot_answer_count):
                print(
                    f"WARNING: Count mismatch! Total ({total_queries}) != Can Answer ({can_answer_count}) + Cannot Answer ({cannot_answer_count})"
                )
                logger.warning(
                    f"Count mismatch! Total ({total_queries}) != Can Answer ({can_answer_count}) + Cannot Answer ({cannot_answer_count})"
                )

            print(f"Answer Hit Rate: {hit_rate:.2f}% ({can_answer_count}/{total_queries})")
            logger.info(f"Answer Hit Rate: {hit_rate:.2f}% ({can_answer_count}/{total_queries})")

    def save_stats(self):
        """
        Serializes and saves the contents of self.stats to the specified path:
        Base_dir/results/frame-version/stats

        This method handles directory creation, thread-safe access to statistics data,
        and proper JSON serialization of complex data structures.
        """
        try:
            # Thread-safe access to the stats data using the lock
            with self.stats_lock:
                # Create a copy of the data to prevent modification during serialization
                stats_data = dict(self.stats)

                # Helper function to convert defaultdict to regular dict for JSON serialization
                def convert_defaultdict(obj):
                    if isinstance(obj, defaultdict):
                        return dict(obj)
                    return obj

                # Debug: Print stats summary before saving
                print(f"DEBUG: Saving stats for {self.frame}-{self.version}")
                print(f"DEBUG: Stats path: {self.stats_path}")
                print(f"DEBUG: Stats data keys: {list(stats_data.keys())}")
                if self.frame in stats_data and self.version in stats_data[self.frame]:
                    frame_data = stats_data[self.frame][self.version]
                    print(f"DEBUG: Memory stats: {frame_data.get('memory_stats', {})}")
                    print(
                        f"DEBUG: Total queries: {frame_data.get('memory_stats', {}).get('total_queries', 0)}"
                    )

                # Serialize and save the statistics data to file
                with self.stats_path.open("w", encoding="utf-8") as fw:
                    json.dump(
                        stats_data, fw, ensure_ascii=False, indent=2, default=convert_defaultdict
                    )

            self.logger.info(f"Successfully saved stats to: {self.stats_path}")
            print(f"DEBUG: Stats file created at {self.stats_path}")

        except Exception as e:
            self.logger.error(f"Failed to save stats: {e!s}")
            self.logger.error(traceback.format_exc())
            print(f"DEBUG: Error saving stats: {e}")

    def get_answer_hit_rate(self):
        """
        Get current answer hit rate statistics.

        Returns:
            dict: Hit rate statistics
        """
        with self.stats_lock:
            return {
                "total_queries": self.stats[self.frame][self.version]["memory_stats"][
                    "total_queries"
                ],
                "can_answer_count": self.stats[self.frame][self.version]["memory_stats"][
                    "can_answer_count"
                ],
                "hit_rate_percentage": self.stats[self.frame][self.version]["memory_stats"][
                    "answer_hit_rate"
                ],
            }

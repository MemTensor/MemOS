"""
Client management module for handling different memory framework clients.
"""

import json
import os

from collections import defaultdict

from mem0 import MemoryClient
from zep_cloud.client import Zep

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS
from memos.mem_scheduler.analyzer.scheduler_for_eval import SchedulerForEval

from .base_eval_module import BaseEvalModule
from .constants import (
    BASE_DIR,
    MEM0_GRAPH_MODEL,
    MEM0_MODEL,
    MEMOS_MODEL,
    MEMOS_SCHEDULER_MODEL,
    ZEP_MODEL,
)
from .prompts import (
    ANSWER_PROMPT_MEM0,
    ANSWER_PROMPT_MEMOS,
    ANSWER_PROMPT_ZEP,
)


logger = get_logger(__name__)


class EvalModuleWithClientManager(BaseEvalModule):
    """
    Manages different memory framework clients for evaluation.
    """

    def __init__(self, args):
        super().__init__(args=args)

    def get_client_for_ingestion(
        self, frame: str, user_id: str | None = None, version: str = "default"
    ):
        if frame == ZEP_MODEL:
            zep = Zep(api_key=os.getenv("ZEP_API_KEY"), base_url="https://api.getzep.com/api/v2")
            return zep

        elif frame in (MEM0_MODEL, MEM0_GRAPH_MODEL):
            mem0 = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
            mem0.update_project(custom_instructions=self.custom_instructions)
            return mem0
        else:
            if frame not in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
                raise NotImplementedError(f"Unsupported framework: {frame}")

            # scheduler is not needed in the ingestion step
            self.mos_config_data["top_k"] = 20
            self.mos_config_data["enable_mem_scheduler"] = False

            mos_config = MOSConfig(**self.mos_config_data)
            mos = MOS(mos_config)
            mos.create_user(user_id=user_id)

            self.mem_cube_config_data["user_id"] = user_id
            self.mem_cube_config_data["cube_id"] = user_id
            self.mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["db_name"] = (
                f"{user_id.replace('_', '')}{version}"
            )
            mem_cube_config = GeneralMemCubeConfig.model_validate(self.mem_cube_config_data)
            mem_cube = GeneralMemCube(mem_cube_config)

            storage_path = str(self.ingestion_storage_dir / user_id)
            try:
                mem_cube.dump(storage_path)
            except Exception as e:
                print(f"dumping memory cube: {e!s} already exists, will use it.")

            mos.register_mem_cube(
                mem_cube_name_or_path=storage_path,
                mem_cube_id=user_id,
                user_id=user_id,
            )

            return mos

    def get_client_from_storage(
        self, frame: str, user_id: str | None = None, version: str = "default", top_k: int = 20
    ):
        """
        Get a client instance for the specified memory framework.

        Args:
            frame: Memory framework to use (zep, mem0, mem0_graph, memos, memos_scheduler)
            user_id: Unique identifier for the user
            version: Version identifier for result storage
            top_k: Number of results to retrieve in search queries

        Returns:
            Client instance for the specified framework
        """
        storage_path = str(self.ingestion_storage_dir / user_id)

        if frame == ZEP_MODEL:
            zep = Zep(api_key=os.getenv("ZEP_API_KEY"), base_url="https://api.getzep.com/api/v2")
            return zep

        elif frame == [MEM0_MODEL, MEM0_GRAPH_MODEL]:
            mem0 = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
            return mem0

        else:
            if frame not in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
                raise NotImplementedError(f"Unsupported framework: {frame}")

            if frame == MEMOS_MODEL:
                self.mos_config_data["enable_mem_scheduler"] = False

            self.mos_config_data["top_k"] = top_k
            mos_config = MOSConfig(**self.mos_config_data)
            mos = MOS(mos_config)
            mos.create_user(user_id=user_id)
            mos.register_mem_cube(
                mem_cube_name_or_path=storage_path,
                mem_cube_id=user_id,
                user_id=user_id,
            )

            if frame == MEMOS_SCHEDULER_MODEL:
                # Configure memory scheduler
                mos.mem_scheduler.current_mem_cube = mos.mem_cubes[user_id]
                mos.mem_scheduler.current_mem_cube_id = user_id
                mos.mem_scheduler.current_user_id = user_id

                # Create SchedulerForEval instance with the same config
                scheduler_for_eval = SchedulerForEval(config=mos.mem_scheduler.config)
                # Initialize with the same modules as the original scheduler
                scheduler_for_eval.initialize_modules(
                    chat_llm=mos.mem_scheduler.chat_llm,
                    process_llm=mos.mem_scheduler.process_llm,
                    db_engine=mos.mem_scheduler.db_engine,
                )
                # Set the same context
                scheduler_for_eval.current_mem_cube = mos.mem_cubes[user_id]
                scheduler_for_eval.current_mem_cube_id = user_id
                scheduler_for_eval.current_user_id = user_id

                # Replace the original scheduler
                mos.mem_scheduler = scheduler_for_eval

            return mos

    def locomo_response(self, frame, llm_client, context: str, question: str) -> str:
        if frame == ZEP_MODEL:
            prompt = ANSWER_PROMPT_ZEP.format(
                context=context,
                question=question,
            )
        elif frame in (MEM0_MODEL, MEM0_GRAPH_MODEL):
            prompt = ANSWER_PROMPT_MEM0.format(
                context=context,
                question=question,
            )
        elif frame in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
            prompt = ANSWER_PROMPT_MEMOS.format(
                context=context,
                question=question,
            )
        else:
            raise NotImplementedError()
        response = llm_client.chat.completions.create(
            model=self.openai_chat_model,
            messages=[
                {"role": "system", "content": prompt},
            ],
            temperature=0,
        )

        result = response.choices[0].message.content or ""

        if result == "":
            with self.stats_lock:
                self.stats[self.frame][self.version]["response_stats"]["response_failure"] += 1
                self.stats[self.frame][self.version]["response_stats"]["response_count"] += 1
        return result

    def group_and_sort_qa_by_day(self, qa_set):
        """
        Groups QA pairs by day and sorts them chronologically within each day group.

        Args:
            qa_set (list): List of dictionaries containing QA data with evidence references

        Returns:
            dict: Dictionary where keys are day strings (e.g., 'D1') and values are
                  lists of QA pairs sorted by evidence order within that day
        """
        # Initialize a dictionary that automatically creates lists for new keys
        day_groups = defaultdict(list)

        # Process each QA pair in the input dataset
        for qa in qa_set:
            # Extract all unique days referenced in this QA pair's evidence
            days = set()
            for evidence in qa["evidence"]:
                # Split evidence string (e.g., 'D1:3') into day and position parts
                day = evidence.split(":")[0]  # Gets 'D1', 'D2', etc.
                days.add(day)

            # Add this QA pair to each day group it references
            for day in days:
                day_groups[day].append(qa)

        # Sort QA pairs within each day group by their earliest evidence position
        for day in day_groups:
            # Create list of (qa, position) pairs for proper sorting
            qa_position_pairs = []

            for qa in day_groups[day]:
                # Find the earliest evidence position for this day
                earliest_position = None
                for evidence in qa["evidence"]:
                    if evidence.startswith(day + ":"):
                        try:
                            position = int(evidence.split(":")[1])
                            if earliest_position is None or position < earliest_position:
                                earliest_position = position
                        except (IndexError, ValueError):
                            # Skip invalid evidence format
                            continue

                if earliest_position is not None:
                    qa_position_pairs.append((qa, earliest_position))

            # Sort by evidence position (earliest first)
            qa_position_pairs = sorted(qa_position_pairs, key=lambda x: x[1])
            day_groups[day] = [qa for qa, _ in qa_position_pairs]

        return dict(day_groups)

    def convert_locomo_to_temporal_locomo(self, output_dir: str | None = None):
        """
        Convert locomo dataset to temporal_locomo dataset format.

        This function processes the original locomo dataset and reorganizes it by days
        with proper chronological ordering within each day group.

        Args:
            output_dir: Output directory for the converted dataset.
                       Defaults to evaluation/data/temporal_locomo/

        Returns:
            str: Path to the converted dataset file
        """
        if output_dir is None:
            output_dir = f"{BASE_DIR}/data/temporal_locomo"

        # Create output directory
        os.makedirs(output_dir, exist_ok=True)

        # Load original locomo data
        locomo_data = self.locomo_df.to_dict("records")

        # Process each conversation
        temporal_data = []

        for conv_id, conversation in enumerate(locomo_data):
            logger.info(f"Processing conversation {conv_id + 1}/{len(locomo_data)}")

            # Get QA pairs for this conversation
            qa_set = conversation.get("qa", [])

            # Group and sort QA pairs by day
            day_groups = self.group_and_sort_qa_by_day(qa_set)

            # Create temporal structure for this conversation
            temporal_conversation = {"conversation_id": f"locomo_exp_user_{conv_id}", "days": {}}

            # Process each day group
            for day, qa_list in day_groups.items():
                temporal_conversation["days"][day] = {
                    "day_id": day,
                    "qa_pairs": qa_list,
                    "total_qa_pairs": len(qa_list),
                }

            temporal_data.append(temporal_conversation)

        # Save the converted dataset
        output_file = os.path.join(output_dir, "temporal_locomo_qa.json")
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(temporal_data, f, indent=2, ensure_ascii=False)

        logger.info(f"Converted dataset saved to: {output_file}")
        logger.info(f"Total conversations: {len(temporal_data)}")

        # Log statistics
        total_qa_pairs = sum(len(conv["qa"]) for conv in locomo_data)
        total_temporal_qa_pairs = sum(
            sum(day_data["total_qa_pairs"] for day_data in conv["days"].values())
            for conv in temporal_data
        )

        logger.info(f"Original QA pairs: {total_qa_pairs}")
        logger.info(f"Temporal QA pairs: {total_temporal_qa_pairs}")
        logger.info("QA pairs may be duplicated across days if they reference multiple days")

        return output_file

    def load_existing_results(self, frame, version, conv_id):
        result_path = self.result_dir / f"/tmp/{frame}_locomo_search_results_{conv_id}.json"

        if os.path.exists(result_path):
            try:
                with open(result_path) as f:
                    return json.load(f), True
            except Exception as e:
                print(f"Error loading existing results for group {conv_id}: {e}")
        return {}, False

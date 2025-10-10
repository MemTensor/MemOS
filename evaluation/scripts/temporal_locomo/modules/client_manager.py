"""
Client management module for handling different memory framework clients.
"""

import os

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

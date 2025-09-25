import json
import sys

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from time import time

from dotenv import load_dotenv
from modules.constants import (
    MEMOS_MODEL,
    MEMOS_SCHEDULER_MODEL,
)
from modules.locomo_eval_module import LocomoEvalModelModules
from modules.prompts import (
    SEARCH_PROMPT_MEM0,
    SEARCH_PROMPT_MEM0_GRAPH,
    SEARCH_PROMPT_MEMOS,
    SEARCH_PROMPT_ZEP,
)
from modules.schemas import ContextUpdateMethod, RecordingCase
from modules.utils import save_evaluation_cases

from memos.log import get_logger


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


class LocomoProcessor(LocomoEvalModelModules):
    """
    A class for handling conversational memory management across different memory frameworks.
    Supports multiple memory backends (zep, mem0, memos, etc.) for searching and retrieving
    relevant context to generate conversational responses.
    """

    def __init__(self, args):
        """Initialize the LocomoChatter with path configurations and templates"""
        super().__init__(args=args)

        # Template definitions for different memory frameworks
        self.search_template_zep = SEARCH_PROMPT_ZEP

        self.search_template_mem0 = SEARCH_PROMPT_MEM0

        self.search_template_mem0_graph = SEARCH_PROMPT_MEM0_GRAPH

        self.search_template_memos = SEARCH_PROMPT_MEMOS

        self.processed_data_dir = self.result_dir / "processed_data"

    def update_context(self, conv_id, method, **kwargs):
        if method == ContextUpdateMethod.DIRECT:
            if "cur_context" not in kwargs:
                raise ValueError("cur_context is required for DIRECT update method")
            cur_context = kwargs["cur_context"]
            self.pre_context_cache[conv_id] = cur_context
        elif method == ContextUpdateMethod.TEMPLATE:
            if "query" not in kwargs or "answer" not in kwargs:
                raise ValueError("query and answer are required for TEMPLATE update method")
            self._update_context_template(conv_id, kwargs["query"], kwargs["answer"])
        else:
            raise ValueError(f"Unsupported update method: {method}")

    def _update_context_template(self, conv_id, query, answer):
        new_context = f"User: {query}\nAssistant: {answer}\n\n"
        if self.pre_context_cache[conv_id] is None:
            self.pre_context_cache[conv_id] = ""
        self.pre_context_cache[conv_id] += new_context

    def _process_single_qa(
        self,
        qa,
        *,
        client,
        reversed_client,
        metadata,
        frame,
        version,
        conv_id,
        conv_stats_path,
        oai_client,
        top_k,
        conv_stats,
    ):
        query = qa.get("question")
        gold_answer = qa.get("answer")
        qa_category = qa.get("category")
        if qa_category == 5:
            return None

        # Search
        cur_context, search_duration_ms = self.search_query(
            client, query, metadata, frame, reversed_client=reversed_client, top_k=top_k
        )
        if not cur_context:
            logger.warning(f"No context found for query: {query[:100]}")
            cur_context = ""

        # Context answerability analysis (for memos_scheduler only)
        if self.pre_context_cache[conv_id] is None:
            # Update pre-context cache with current context
            if self.frame in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
                self.update_context(
                    conv_id=conv_id,
                    method=self.context_update_method,
                    cur_context=cur_context,
                )
            else:
                self.update_context(
                    conv_id=conv_id,
                    method=self.context_update_method,
                    query=query,
                    answer=gold_answer,
                )
            return None

        can_answer = False
        can_answer_duration_ms = 0.0
        can_answer_start = time()
        can_answer = self.analyze_context_answerability(
            self.pre_context_cache[conv_id], query, gold_answer, oai_client
        )
        can_answer_duration_ms = (time() - can_answer_start) * 1000
        # Update global stats
        with self.stats_lock:
            self.stats[self.frame][self.version]["memory_stats"]["total_queries"] += 1
            if can_answer:
                self.stats[self.frame][self.version]["memory_stats"]["can_answer_count"] += 1
            else:
                self.stats[self.frame][self.version]["memory_stats"]["cannot_answer_count"] += 1
            total_queries = self.stats[self.frame][self.version]["memory_stats"]["total_queries"]
            can_answer_count = self.stats[self.frame][self.version]["memory_stats"][
                "can_answer_count"
            ]
            hit_rate = (can_answer_count / total_queries * 100) if total_queries > 0 else 0
            self.stats[self.frame][self.version]["memory_stats"]["answer_hit_rate"] = hit_rate
            self.stats[self.frame][self.version]["memory_stats"]["can_answer_duration_ms"] = (
                can_answer_duration_ms
            )
            self.save_stats()

        # Generate answer
        answer_start = time()
        answer = self.locomo_response(frame, oai_client, self.pre_context_cache[conv_id], query)
        response_duration_ms = (time() - answer_start) * 1000

        # Record case for memos_scheduler
        if frame == "memos_scheduler":
            try:
                recording_case = RecordingCase(
                    conv_id=conv_id,
                    query=query,
                    answer=answer,
                    context=cur_context,
                    pre_context=self.pre_context_cache[conv_id],
                    can_answer=can_answer,
                    can_answer_reason=f"Context analysis result: {'can answer' if can_answer else 'cannot answer'}",
                    search_duration_ms=search_duration_ms,
                    can_answer_duration_ms=can_answer_duration_ms,
                    response_duration_ms=response_duration_ms,
                    category=int(qa_category) if qa_category is not None else None,
                    golden_answer=str(qa.get("answer", "")),
                    memories=[],
                    pre_memories=[],
                    history_queries=[],
                )
                if can_answer:
                    self.can_answer_cases.append(recording_case)
                else:
                    self.cannot_answer_cases.append(recording_case)
            except Exception as e:
                logger.error(f"Error creating RecordingCase: {e}")
                print(f"Error creating RecordingCase: {e}")
                logger.error(f"QA data: {qa}")
                print(f"QA data: {qa}")
                logger.error(f"Query: {query}")
                logger.error(f"Answer: {answer}")
                logger.error(
                    f"Golden answer (raw): {qa.get('answer')} (type: {type(qa.get('answer'))})"
                )
                logger.error(f"Category: {qa_category} (type: {type(qa_category)})")
                logger.error(f"Can answer: {can_answer}")
                raise e

        # Update conversation stats
        conv_stats["total_queries"] += 1
        conv_stats["response_count"] += 1
        if frame == "memos_scheduler":
            if can_answer:
                conv_stats["can_answer_count"] += 1
            else:
                conv_stats["cannot_answer_count"] += 1
        if conv_stats["total_queries"] > 0:
            conv_stats["answer_hit_rate"] = (
                conv_stats["can_answer_count"] / conv_stats["total_queries"]
            ) * 100

        # Persist conversation stats snapshot
        self._save_conv_stats(conv_id, frame, version, conv_stats, conv_stats_path)

        logger.info(f"Processed question: {query[:100]}")
        logger.info(f"Answer: {answer[:100]}")

        # Update pre-context cache with current context
        with self.stats_lock:
            if self.frame in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
                self.update_context(
                    conv_id=conv_id,
                    method=self.context_update_method,
                    cur_context=cur_context,
                )
            else:
                self.update_context(
                    conv_id=conv_id,
                    method=self.context_update_method,
                    query=query,
                    answer=gold_answer,
                )

        self.print_eval_info()

        return {
            "question": query,
            "answer": answer,
            "category": qa_category,
            "golden_answer": gold_answer,
            "search_context": cur_context,
            "response_duration_ms": response_duration_ms,
            "search_duration_ms": search_duration_ms,
            "can_answer_duration_ms": can_answer_duration_ms,
            "can_answer": can_answer if frame == "memos_scheduler" else None,
        }

    def run_locomo_processing(self, num_users=10):
        load_dotenv()

        frame = self.frame
        version = self.version
        num_workers = self.workers
        top_k = self.top_k

        # Storage for aggregated results
        all_search_results = defaultdict(list)
        all_response_results = defaultdict(list)
        num_users = num_users

        # Prepare arguments for each user processing task
        user_args = [(idx, self.locomo_df, frame, version, top_k) for idx in range(num_users)]

        if num_workers > 1:
            # === parallel running ====
            # Use ThreadPoolExecutor for parallel processing
            print(
                f"Starting parallel processing for {num_users} users, using {num_workers} workers for sessions..."
            )
            with ThreadPoolExecutor(max_workers=num_workers) as executor:
                # Submit all user processing tasks
                future_to_user = {
                    executor.submit(self.process_user_wrapper, args): idx
                    for idx, args in enumerate(user_args)
                }

                # Collect results as they complete
                for future in as_completed(future_to_user):
                    idx = future_to_user[future]
                    user_search_results, user_response_results, error = future.result()
                    if error is not None:
                        idx, e, traceback_str = error
                        print(f"Error processing user {idx}: {e}. Exception: {traceback_str}")
                    else:
                        # Aggregate results
                        conv_id = f"locomo_exp_user_{idx}"
                        all_search_results[conv_id].extend(user_search_results[conv_id])
                        all_response_results[conv_id].extend(user_response_results[conv_id])

        else:
            # Serial processing
            print(
                f"Starting serial processing for {num_users} users in serial mode, each user using {num_workers} workers for sessions..."
            )
            for idx, args in enumerate(user_args):
                user_search_results, user_response_results, error = self.process_user_wrapper(args)
                if error is not None:
                    idx, e, traceback_str = error
                    print(f"Error processing user {idx}: {e}. Exception: {traceback_str}")
                else:
                    # Aggregate results
                    conv_id = f"locomo_exp_user_{idx}"
                    all_search_results[conv_id].extend(user_search_results[conv_id])
                    all_response_results[conv_id].extend(user_response_results[conv_id])

        # Print evaluation information statistics
        self.print_eval_info()
        self.save_stats()

        # Save all aggregated results
        with open(self.search_path, "w") as fw:
            json.dump(all_search_results, fw, indent=2)
            print(f"Saved all search results to {self.search_path}")

        with open(self.response_path, "w") as fw:
            json.dump(all_response_results, fw, indent=2)
            print(f"Saved all response results to {self.response_path}")

        # Save evaluation cases if they exist
        if self.can_answer_cases or self.cannot_answer_cases:
            try:
                saved_files = save_evaluation_cases(
                    can_answer_cases=self.can_answer_cases,
                    cannot_answer_cases=self.cannot_answer_cases,
                    output_dir=self.stats_dir,
                    frame=self.frame,
                    version=self.version,
                )
                print(f"Saved evaluation cases: {saved_files}")
            except Exception as e:
                logger.error(f"Error saving evaluation cases: {e}")

        return dict(all_search_results), dict(all_response_results)

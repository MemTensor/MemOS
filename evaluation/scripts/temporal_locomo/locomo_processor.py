import json
import sys
import traceback

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
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
from modules.schemas import RecordingCase
from modules.utils import save_evaluation_cases
from openai import OpenAI
from tqdm import tqdm

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

    # -------------------------------
    # Refactor helpers for process_user
    # -------------------------------

    def _initialize_conv_stats(self):
        """Create a fresh statistics dictionary for a conversation."""
        return {
            "total_queries": 0,
            "can_answer_count": 0,
            "cannot_answer_count": 0,
            "answer_hit_rate": 0.0,
            "response_failure": 0,
            "response_count": 0,
        }

    def _build_day_groups(self, temporal_conv):
        """Build mapping day_id -> qa_pairs from a temporal conversation dict."""
        day_groups = {}
        for day_id, day_data in temporal_conv.get("days", {}).items():
            day_groups[day_id] = day_data.get("qa_pairs", [])
        return day_groups

    def _build_metadata(self, speaker_a, speaker_b, speaker_a_user_id, speaker_b_user_id, conv_id):
        """Assemble metadata for downstream calls."""
        return {
            "speaker_a": speaker_a,
            "speaker_b": speaker_b,
            "speaker_a_user_id": speaker_a_user_id,
            "speaker_b_user_id": speaker_b_user_id,
            "conv_id": conv_id,
        }

    def _get_clients(self, frame, speaker_a_user_id, speaker_b_user_id, conv_id, version, top_k):
        """Return (client, reversed_client) according to the target frame."""
        reversed_client = None
        if frame in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
            client = self.get_client_from_storage(frame, speaker_a_user_id, version, top_k=top_k)
            reversed_client = self.get_client_from_storage(
                frame, speaker_b_user_id, version, top_k=top_k
            )
        else:
            client = self.get_client_from_storage(frame, conv_id, version)
        return client, reversed_client

    def _save_conv_stats(self, conv_id, frame, version, conv_stats, conv_stats_path):
        """Persist per-conversation stats to disk."""
        conv_stats_data = {
            "conversation_id": conv_id,
            "frame": frame,
            "version": version,
            "statistics": conv_stats,
            "timestamp": str(datetime.now()),
        }
        with open(conv_stats_path, "w") as fw:
            json.dump(conv_stats_data, fw, indent=2, ensure_ascii=False)
            print(f"Saved conversation stats for {conv_id} to {conv_stats_path}")

    def _write_user_search_results(self, user_search_path, search_results, conv_id):
        """Write per-user search results to a temporary JSON file."""
        with open(user_search_path, "w") as fw:
            json.dump(dict(search_results), fw, indent=2)
            print(f"Save search results {conv_id}")

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
        qa_category = qa.get("category")
        if qa_category == 5:
            return None

        # Search
        context, search_duration_ms = self.search_query(
            client, query, metadata, frame, reversed_client=reversed_client, top_k=top_k
        )
        if not context:
            logger.warning(f"No context found for query: {query[:100]}")
            context = ""

        # Context answerability analysis (for memos_scheduler only)
        gold_answer = qa.get("answer")
        if self.pre_context_cache[conv_id] is None:
            # Update pre-context cache with current context
            with self.stats_lock:
                self.pre_context_cache[conv_id] = context
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

        # Update pre-context cache with current context
        with self.stats_lock:
            self.pre_context_cache[conv_id] = context

        self.print_eval_info()

        # Generate answer
        answer_start = time()
        answer = self.locomo_response(frame, oai_client, context, query)
        response_duration_ms = (time() - answer_start) * 1000

        # Record case for memos_scheduler
        if frame == "memos_scheduler":
            try:
                recording_case = RecordingCase(
                    conv_id=conv_id,
                    query=query,
                    answer=answer,
                    context=context,
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
        return {
            "question": query,
            "answer": answer,
            "category": qa_category,
            "golden_answer": gold_answer,
            "search_context": context,
            "response_duration_ms": response_duration_ms,
            "search_duration_ms": search_duration_ms,
            "can_answer_duration_ms": can_answer_duration_ms,
            "can_answer": can_answer if frame == "memos_scheduler" else None,
        }

    def process_user(self, conv_id, locomo_df, frame, version, top_k=20):
        user_search_path = self.result_dir / f"tmp/{frame}_locomo_search_results_{conv_id}.json"
        user_search_path.parent.mkdir(exist_ok=True, parents=True)
        search_results = defaultdict(list)
        response_results = defaultdict(list)
        conv_stats_path = self.stats_dir / f"{frame}_{version}_conv_{conv_id}_stats.json"

        conversation = locomo_df["conversation"].iloc[conv_id]
        speaker_a = conversation.get("speaker_a", "speaker_a")
        speaker_b = conversation.get("speaker_b", "speaker_b")

        # Use temporal_locomo data if available, otherwise fall back to original locomo data
        temporal_conv = self.temporal_locomo_data[conv_id]
        conv_id = temporal_conv["conversation_id"]
        speaker_a_user_id = f"{conv_id}_speaker_a"
        speaker_b_user_id = f"{conv_id}_speaker_b"

        # Process temporal data by days
        day_groups = {}
        for day_id, day_data in temporal_conv["days"].items():
            day_groups[day_id] = day_data["qa_pairs"]

        # Initialize conversation-level statistics
        conv_stats = self._initialize_conv_stats()

        metadata = self._build_metadata(
            speaker_a, speaker_b, speaker_a_user_id, speaker_b_user_id, conv_id
        )

        client, reversed_client = self._get_clients(
            frame, speaker_a_user_id, speaker_b_user_id, conv_id, version, top_k
        )

        oai_client = OpenAI(api_key=self.openai_api_key, base_url=self.openai_base_url)

        with self.stats_lock:
            self.pre_context_cache[conv_id] = None

        def process_qa(qa):
            return self._process_single_qa(
                qa,
                client=client,
                reversed_client=reversed_client,
                metadata=metadata,
                frame=frame,
                version=version,
                conv_id=conv_id,
                conv_stats_path=conv_stats_path,
                oai_client=oai_client,
                top_k=top_k,
                conv_stats=conv_stats,
            )

        # ===================================
        conv_stats["theoretical_total_queries"] = 0
        for day, qa_list in day_groups.items():
            conv_stats["theoretical_total_queries"] += len(qa_list) - 1
            conv_stats["processing_failure_count"] = 0
            print(f"Processing user {conv_id} day {day}")
            for qa in tqdm(qa_list, desc=f"Processing user {conv_id} day {day}"):
                try:
                    result = process_qa(qa)
                except Exception as e:
                    logger.error(f"Error: {e}. traceback: {traceback.format_exc()}")
                    conv_stats["processing_failure_count"] += 1
                    continue
                if result:
                    context_preview = (
                        result["search_context"][:20] + "..."
                        if result["search_context"]
                        else "No context"
                    )
                    if "can_answer" in result:
                        logger.info("Print can_answer case")
                        logger.info(
                            {
                                "question": result["question"][:100],
                                "pre context can answer": result["can_answer"],
                                "answer": result["answer"][:100],
                                "golden_answer": result["golden_answer"],
                                "search_context": context_preview[:100],
                                "search_duration_ms": result["search_duration_ms"],
                            }
                        )

                    search_results[conv_id].append(
                        {
                            "question": result["question"],
                            "context": result["search_context"],
                            "search_duration_ms": result["search_duration_ms"],
                        }
                    )
                    response_results[conv_id].append(result)

            logger.warning(
                f"Finished processing user {conv_id} day {day}, data_length: {len(qa_list)}"
            )

        # recording separate search results
        with open(user_search_path, "w") as fw:
            json.dump(dict(search_results), fw, indent=2)
            print(f"Save search results {conv_id}")

        # Dump stats after processing each user
        self.save_stats()

        return search_results, response_results

    def process_user_wrapper(self, args):
        """
        Wraps the process_user function to support parallel execution and error handling.

        Args:
            args: Tuple containing parameters for process_user

        Returns:
            tuple: Contains user results or error information
        """
        idx, locomo_df, frame, version, top_k = args
        try:
            print(f"Processing user {idx}...")
            user_search_results, user_response_results = self.process_user(
                idx, locomo_df, frame, version, top_k
            )
            return (user_search_results, user_response_results, None)
        except Exception as e:
            return (None, None, (idx, e, traceback.format_exc()))

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

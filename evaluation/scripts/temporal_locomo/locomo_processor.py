import json
import sys
import traceback

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

    def process_user(self, conv_id, locomo_df, frame, version, top_k=20):
        user_search_path = self.result_dir / f"tmp/{frame}_locomo_search_results_{conv_id}.json"
        user_search_path.parent.mkdir(exist_ok=True, parents=True)
        search_results = defaultdict(list)
        response_results = defaultdict(list)

        conversation = locomo_df["conversation"].iloc[conv_id]
        speaker_a = conversation.get("speaker_a", "speaker_a")
        speaker_b = conversation.get("speaker_b", "speaker_b")

        # Use temporal_locomo data if available, otherwise fall back to original locomo data
        temporal_conv = self.temporal_locomo_data[conv_id]
        conv_id = temporal_conv["conversation_id"]

        # Process temporal data by days
        day_groups = {}
        for day_id, day_data in temporal_conv["days"].items():
            day_groups[day_id] = day_data["qa_pairs"]

        speaker_a_user_id = f"{conv_id}_speaker_a"
        speaker_b_user_id = f"{conv_id}_speaker_b"
        existing_results, loaded = self.load_existing_results(frame, version, conv_id)
        if loaded:
            print(f"Loaded existing results for group {conv_id}")
            return existing_results

        # ============== func =================
        metadata = {
            "speaker_a": speaker_a,
            "speaker_b": speaker_b,
            "speaker_a_user_id": speaker_a_user_id,
            "speaker_b_user_id": speaker_b_user_id,
            "conv_id": conv_id,
        }

        reversed_client = None
        if frame in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
            client = self.get_client_from_storage(frame, speaker_a_user_id, version, top_k=top_k)
            reversed_client = self.get_client_from_storage(
                frame, speaker_b_user_id, version, top_k=top_k
            )
        else:
            client = self.get_client_from_storage(frame, conv_id, version)

        oai_client = OpenAI(api_key=self.openai_api_key, base_url=self.openai_base_url)

        with self.stats_lock:
            self.pre_context_cache[conv_id] = None

        def process_qa(qa):
            try:
                query = qa.get("question")
                qa_category = qa.get("category")
                if qa_category == 5:
                    return None

                # ==== Search ====
                context, search_duration_ms = self.search_query(
                    client, query, metadata, frame, reversed_client=reversed_client, top_k=top_k
                )

                if not context:
                    logger.warning(f"No context found for query: {query[:100]}")
                    context = ""

                # ==== Context Answerability Analysis (for memos_scheduler only) ====
                can_answer = False
                can_answer_duration_ms = 0.0
                if self.pre_context_cache[conv_id] is not None:
                    can_answer_start = time()
                    can_answer = self.analyze_context_answerability(
                        self.pre_context_cache[conv_id], query, oai_client
                    )
                    can_answer_duration_ms = (time() - can_answer_start) * 1000
                    # Update statistics
                    with self.stats_lock:
                        self.stats[self.frame][self.version]["memory_stats"]["total_queries"] += 1
                        if can_answer:
                            self.stats[self.frame][self.version]["memory_stats"][
                                "can_answer_count"
                            ] += 1
                        else:
                            self.stats[self.frame][self.version]["memory_stats"][
                                "cannot_answer_count"
                            ] += 1

                        # Calculate hit rate
                        total_queries = self.stats[self.frame][self.version]["memory_stats"][
                            "total_queries"
                        ]
                        can_answer_count = self.stats[self.frame][self.version]["memory_stats"][
                            "can_answer_count"
                        ]
                        hit_rate = (
                            (can_answer_count / total_queries * 100) if total_queries > 0 else 0
                        )
                        self.stats[self.frame][self.version]["memory_stats"]["answer_hit_rate"] = (
                            hit_rate
                        )
                        self.save_stats()
                with self.stats_lock:
                    self.pre_context_cache[conv_id] = context

                self.print_eval_info()

                # ==== Answer ====
                gold_answer = qa.get("answer")

                answer_start = time()
                answer = self.locomo_response(frame, oai_client, context, query)

                response_duration_ms = (time() - answer_start) * 1000

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
            except Exception as e:
                logger.error(f"Error: {e}. traceback: {traceback.format_exc()}")

        # ===================================
        for day, qa_list in day_groups.items():
            print(f"Processing user {conv_id} day {day}")
            for qa in tqdm(qa_list, desc=f"Processing user {conv_id} day {day}"):
                result = process_qa(qa)

                if result:
                    context_preview = (
                        result["search_context"][:20] + "..."
                        if result["search_context"]
                        else "No context"
                    )
                    if "can_answer" in result:
                        print("Print can_answer examples")
                        print(
                            {
                                "question": result["question"][:100],
                                "pre context can answer": result["can_answer"],
                                "answer": result["answer"][:100],
                                "category": result["category"],
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

    def run_locomo_processing(self):
        """
        Runs the Locomo processing pipeline, including user data processing, memory searching,
        and result persistence.

        Args:
            frame (str): Type of memory framework to use
            version (str): Version identifier for result storage
            num_workers (int): Number of parallel worker threads
            top_k (int): Maximum number of search results to retrieve

        Returns:
            tuple: Contains two dictionaries - all search results and all response results
        """
        load_dotenv()

        frame = self.frame
        version = self.version
        num_workers = self.workers
        top_k = self.top_k

        # Storage for aggregated results
        all_search_results = defaultdict(list)
        all_response_results = defaultdict(list)
        num_users = 10

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
                    user_idx = future_to_user[future]
                    try:
                        user_search_results, user_response_results, error = future.result()
                        if error is not None:
                            idx, e, traceback_str = error
                            print(f"Error processing user {idx}: {e}. Exception: {traceback_str}")
                        else:
                            # Aggregate results
                            all_search_results[user_idx].extend(user_search_results)
                            all_response_results[user_idx].extend(user_response_results)
                    except Exception as e:
                        print(f"Error processing user {user_idx}: {e}")
        else:
            # Serial processing
            print(
                f"Starting serial processing for {num_users} users in serial mode, each user using {num_workers} workers for sessions..."
            )
            for idx, args in enumerate(user_args):
                try:
                    user_search_results, user_response_results, error = self.process_user_wrapper(
                        args
                    )
                    if error is not None:
                        user_idx, e, traceback_str = error
                        print(f"Error processing user {user_idx}: {e}. Exception: {traceback_str}")
                    else:
                        # Aggregate results
                        all_search_results[idx].extend(user_search_results)
                        all_response_results[idx].extend(user_response_results)
                except Exception as e:
                    print(f"Error processing user {idx}: {e}")

        # Print evaluation information statistics
        self.print_eval_info()
        self.save_stats()

        # Save all aggregated results
        with open(self.search_path, "w") as fw:
            json.dump(dict(all_search_results), fw, indent=2)
            print(f"Saved all search results to {self.search_path}")

        with open(self.response_path, "w") as fw:
            json.dump(dict(all_response_results), fw, indent=2)
            print(f"Saved all response results to {self.response_path}")

        return dict(all_search_results), dict(all_response_results)

import sys
import time

from pathlib import Path
from typing import TYPE_CHECKING

from evaluation.scripts.temporal_locomo.models.locomo_processor import LocomoProcessor
from evaluation.scripts.temporal_locomo.modules.constants import (
    MEMOS_SCHEDULER_MODEL,
)
from evaluation.scripts.temporal_locomo.modules.prompts import (
    SEARCH_PROMPT_MEMOS,
)
from evaluation.scripts.temporal_locomo.modules.schemas import ContextUpdateMethod, RecordingCase
from memos.log import get_logger


if TYPE_CHECKING:
    from memos.mem_os.main import MOS

FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


class LocomoProcessorWithTimeEval(LocomoProcessor):
    def __init__(self, args):
        super().__init__(args=args)
        self.time_eval_mode = getattr(self.args, "time_eval_mode", False)
        assert self.args.frame == MEMOS_SCHEDULER_MODEL
        assert self.context_update_method == ContextUpdateMethod.PRE_CONTEXT
        if self.time_eval_mode:
            logger.warning(
                "time_eval_mode is activated. _process_single_qa is replaced by _process_single_qa_for_time_eval"
            )
        self._process_single_qa = self._process_single_qa_for_time_eval

    def memos_scheduler_search(
        self, client, query, conv_id, speaker_a, speaker_b, reversed_client=None, top_k=20
    ):
        # MemOS full search process and skip the parts of scheduler
        start = time.time()
        client: MOS = client

        if not self.scheduler_flag:
            # if not scheduler_flag, search to update working memory
            self.memos_search(client, query, conv_id, speaker_a, speaker_b, reversed_client)

        # ========= MemOS Search =========
        # Search for speaker A
        search_a_results = client.search(
            query=query,
            user_id=conv_id + "_speaker_a",
            install_cube_ids=[conv_id + "_speaker_a"],
            top_k=top_k,
            mode="fine",
            internet_search=False,
            moscube=False,  # cube for mos introduction
            session_id=None,
        )["text_mem"]
        search_a_results = [[m.memory for m in one["memories"]] for one in search_a_results]
        search_a_results = [item for sublist in search_a_results for item in sublist]

        # Search for speaker B
        search_b_results = client.search(
            query=query,
            user_id=conv_id + "_speaker_b",
            install_cube_ids=[conv_id + "_speaker_b"],
            top_k=top_k,
            mode="fine",
            internet_search=False,
            moscube=False,  # cube for mos introduction
            session_id=None,
        )["text_mem"]
        search_b_results = [[m.memory for m in one["memories"]] for one in search_b_results]
        search_b_results = [item for sublist in search_b_results for item in sublist]

        speaker_a_context = ""
        for item in search_a_results:
            speaker_a_context += f"{item}\n"

        speaker_b_context = ""
        for item in search_b_results:
            speaker_b_context += f"{item}\n"

        context = SEARCH_PROMPT_MEMOS.format(
            speaker_1=speaker_a,
            speaker_1_memories=speaker_a_context,
            speaker_2=speaker_b,
            speaker_2_memories=speaker_b_context,
        )

        logger.info(f'query "{query[:100]}", context: {context[:100]}"')
        duration_ms = (time.time() - start) * 1000

        return context, duration_ms

    def _process_single_qa_for_time_eval(
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

        # 1. two parallel process,
        # 1. memos search + response
        # 2. pre_memories can answer, true : direct answer   false:

        # Search
        assert self.args.frame == MEMOS_SCHEDULER_MODEL
        cur_context, search_duration_ms = self.search_query(
            client, query, metadata, frame, reversed_client=reversed_client, top_k=top_k
        )
        if not cur_context:
            logger.warning(f"No context found for query: {query[:100]}")
            cur_context = ""

        # Context answer ability analysis (for memos_scheduler only)
        if self.pre_context_cache[conv_id] is None:
            # Update pre-context cache with current context and return
            self.update_context(
                conv_id=conv_id,
                method=self.context_update_method,
                cur_context=cur_context,
            )

            # ========= MemOS Scheduler update =========
            _ = client.mem_scheduler.update_working_memory_for_eval(
                query=query, user_id=conv_id + "_speaker_a", top_k=top_k
            )

            _ = client.mem_scheduler.update_working_memory_for_eval(
                query=query, user_id=conv_id + "_speaker_b", top_k=top_k
            )
            return None

        context = self.pre_context_cache[conv_id]

        # Generate answer
        answer_start = time.time()
        answer = self.locomo_response(frame, oai_client, context, query)
        response_duration_ms = (time.time() - answer_start) * 1000

        can_answer, can_answer_duration_ms = self.eval_context(
            context=context, query=query, gold_answer=gold_answer, oai_client=oai_client
        )

        # Record case for memos_scheduler
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

        # Update conversation stats and context
        self._update_stats_and_context(
            conv_id=conv_id,
            frame=frame,
            version=version,
            conv_stats=conv_stats,
            conv_stats_path=conv_stats_path,
            query=query,
            answer=answer,
            gold_answer=gold_answer,
            cur_context=cur_context,
            can_answer=can_answer,
        )
        # ========= MemOS Scheduler update =========
        _ = client.mem_scheduler.update_working_memory_for_eval(
            query=query, user_id=conv_id + "_speaker_a", top_k=top_k
        )

        _ = client.mem_scheduler.update_working_memory_for_eval(
            query=query, user_id=conv_id + "_speaker_b", top_k=top_k
        )
        return {
            "question": query,
            "answer": answer,
            "category": qa_category,
            "golden_answer": gold_answer,
            "search_context": cur_context,
            "response_duration_ms": response_duration_ms,
            "search_duration_ms": search_duration_ms,
            "can_answer_duration_ms": can_answer_duration_ms,
            "can_answer": can_answer if frame == MEMOS_SCHEDULER_MODEL else None,
        }

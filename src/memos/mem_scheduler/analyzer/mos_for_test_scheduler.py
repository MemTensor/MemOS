from datetime import datetime

from memos.configs.mem_os import MOSConfig
from memos.log import get_logger
from memos.mem_os.main import MOS
from memos.mem_scheduler.schemas.general_schemas import (
    ANSWER_LABEL,
    MONITOR_WORKING_MEMORY_TYPE,
    QUERY_LABEL,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


logger = get_logger(__name__)


class MOSForTestScheduler(MOS):
    """This class is only to test abilities of mem scheduler with enhanced monitoring"""

    def __init__(self, config: MOSConfig):
        super().__init__(config)
        self.memory_helpfulness_analysis = []

    def _str_memories(self, memories: list[str]) -> str:
        """Format memories for display."""
        if not memories:
            return "No memories."
        return "\n".join(f"{i + 1}. {memory}" for i, memory in enumerate(memories))

    def _analyze_memory_helpfulness(
        self,
        query: str,
        working_memories_before: list,
        working_memories_after: list,
        scheduler_memories: list,
    ):
        """Analyze how helpful each memory is for answering the current query."""
        print("\n" + "=" * 80)
        print("🧠 MEMORY HELPFULNESS ANALYSIS FOR QUERY")
        print("=" * 80)

        print(f"📝 Query: {query}")
        print(f"📊 Working Memories Before Scheduler: {len(working_memories_before)}")
        print(f"📊 Working Memories After Scheduler: {len(working_memories_after)}")
        print(f"📊 Working Memories from Monitor: {len(scheduler_memories)}")

        # Display working memories before scheduler (first 5 only)
        if working_memories_before:
            print("\n🔄 WORKING MEMORIES BEFORE SCHEDULER (first 5):")
            for i, mem in enumerate(working_memories_before[:5]):
                print(f"   {i + 1}. {mem}")

        # Display working memories after scheduler (first 5 only)
        if working_memories_after:
            print("\n🔄 WORKING MEMORIES AFTER SCHEDULER (first 5):")
            for i, mem in enumerate(working_memories_after[:5]):
                print(f"   {i + 1}. {mem}")

        # Display scheduler memories from monitor (first 5 only)
        if scheduler_memories:
            print("\n🔄 WORKING MEMORIES FROM MONITOR (first 5):")
            for i, mem in enumerate(scheduler_memories[:5]):
                print(f"   {i + 1}. {mem}")

        # Batch assess working memory helpfulness before scheduler
        if working_memories_before:
            print(
                f"\n🔄 WORKING MEMORY HELPFULNESS BEFORE SCHEDULER ({len(working_memories_before)}):"
            )
            before_assessment = self._batch_assess_memories(
                query, working_memories_before[:5], "before scheduler"
            )
            for i, (_mem, score, reason) in enumerate(before_assessment):
                print(f"   {i + 1}. Helpfulness: {score}/10 - {reason}")

        # Batch assess working memory helpfulness after scheduler
        if working_memories_after:
            print(
                f"\n🔄 WORKING MEMORY HELPFULNESS AFTER SCHEDULER ({len(working_memories_after)}):"
            )
            after_assessment = self._batch_assess_memories(
                query, working_memories_after[:5], "after scheduler"
            )
            for i, (_mem, score, reason) in enumerate(after_assessment):
                print(f"   {i + 1}. Helpfulness: {score}/10 - {reason}")

        # Batch assess scheduler memories from monitor
        if scheduler_memories:
            print(f"\n🔄 WORKINGMEMORIES FROM MONITOR HELPFULNESS ({len(scheduler_memories)}):")
            scheduler_assessment = self._batch_assess_memories(
                query, scheduler_memories[:5], "from monitor"
            )
            for i, (_mem, score, reason) in enumerate(scheduler_assessment):
                print(f"   {i + 1}. Helpfulness: {score}/10 - {reason}")

        # Overall assessment - compare before vs after vs scheduler
        print("\n💡 OVERALL ASSESSMENT:")
        if working_memories_before and working_memories_after:
            before_scores = (
                [score for _, score, _ in before_assessment]
                if "before_assessment" in locals()
                else []
            )
            after_scores = (
                [score for _, score, _ in after_assessment]
                if "after_assessment" in locals()
                else []
            )
            scheduler_scores = (
                [score for _, score, _ in scheduler_assessment]
                if "scheduler_assessment" in locals()
                else []
            )

            avg_before_helpfulness = sum(before_scores) / len(before_scores)
            avg_after_helpfulness = sum(after_scores) / len(after_scores)

            print(f"   Average Helpfulness Before Scheduler: {avg_before_helpfulness:.1f}/10")
            print(f"   Average Helpfulness After Scheduler: {avg_after_helpfulness:.1f}/10")
            print(f"   Improvement: {avg_after_helpfulness - avg_before_helpfulness:+.1f}")

            if avg_after_helpfulness > avg_before_helpfulness:
                print("   ✅ Scheduler improved working memory quality")
            elif avg_after_helpfulness < avg_before_helpfulness:
                print("   ❌ Scheduler decreased working memory quality")
            else:
                print("   ⚖️  Scheduler maintained working memory quality")

            # Compare scheduler memories vs working memories

            avg_scheduler_helpfulness = sum(scheduler_scores) / len(scheduler_scores)
            print(
                f"   Average Helpfulness of Memories from Monitors: {avg_scheduler_helpfulness:.1f}/10"
            )

            if avg_scheduler_helpfulness > avg_after_helpfulness:
                print("   🎯 Memories from Monitors are more helpful than working memories")
            elif avg_scheduler_helpfulness < avg_after_helpfulness:
                print("   ⚠️  Working memories are more helpful than Memories from Monitors")
            else:
                print(
                    "   ⚖️  WORKING Memories from Monitors and working memories have similar helpfulness"
                )

        # Record analysis results
        self.memory_helpfulness_analysis.append(
            {
                "query": query,
                "working_memories_before_count": len(working_memories_before),
                "working_memories_after_count": len(working_memories_after),
                "scheduler_memories_count": len(scheduler_memories),
                "working_helpfulness_before": [score for _, score, _ in before_assessment]
                if "before_assessment" in locals()
                else [],
                "working_helpfulness_after": [score for _, score, _ in after_assessment]
                if "after_assessment" in locals()
                else [],
                "scheduler_helpfulness": [score for _, score, _ in scheduler_assessment]
                if "scheduler_assessment" in locals()
                else [],
            }
        )

        print("=" * 80 + "\n")

    def _batch_assess_memories(self, query: str, memories: list, context: str) -> list:
        """Use LLM to assess multiple memories at once and compare their quality."""
        try:
            # Create prompt for batch assessment
            memories_text = "\n".join([f"{i + 1}. {mem}" for i, mem in enumerate(memories)])

            assessment_prompt = f"""
            Task: Assess and compare the helpfulness of multiple memories for answering a query.

            Query: "{query}"

            Context: These are working memories {context}.

            Memories to assess:
            {memories_text}

            Please provide:
            1. A helpfulness score from 1-10 for each memory (where 10 = extremely helpful, 1 = not helpful at all)
            2. A brief reason for each score
            3. Rank the memories from most helpful to least helpful

            Format your response as:
            Memory 1: Score [number] - [reason]
            Memory 2: Score [number] - [reason]
            Memory 3: Score [number] - [reason]
            Memory 4: Score [number] - [reason]
            Memory 5: Score [number] - [reason]

            Ranking: [memory numbers in order from most to least helpful]

            Consider:
            - Direct relevance to the query
            - Information completeness
            - How directly it answers the question
            - Whether it provides useful context or background
            - Compare memories against each other for relative quality
            """

            # Use the chat LLM to get batch assessment
            messages = [{"role": "user", "content": assessment_prompt}]
            response = self.chat_llm.generate(messages)

            # Parse the response to extract scores and reasons
            assessment_results = []
            lines = response.strip().split("\n")

            for i, mem in enumerate(memories):
                score = 5  # Default score
                reason = "LLM assessment failed, using default score"

                # Look for the corresponding memory line
                for line in lines:
                    if line.startswith(f"Memory {i + 1}:"):
                        try:
                            # Extract score and reason from line like "Memory 1: Score 8 - Highly relevant"
                            parts = line.split("Score ")[1].split(" - ", 1)
                            score = int(parts[0])
                            score = max(1, min(10, score))  # Ensure score is 1-10
                            reason = parts[1] if len(parts) > 1 else "No reason provided"
                        except Exception:
                            pass
                        break

                assessment_results.append((mem, score, reason))

            return assessment_results

        except Exception as e:
            logger.warning(f"LLM batch assessment failed: {e}, using fallback scoring")
            # Fallback to individual assessment if batch fails
            return [
                (
                    mem,
                    self._assess_memory_helpfulness(query, mem)["score"],
                    self._assess_memory_helpfulness(query, mem)["reason"],
                )
                for mem in memories
            ]

    def _assess_memory_helpfulness(self, query: str, memory: str) -> dict:
        """Use LLM to assess how helpful a memory is for answering the current query (1-10 scale)"""
        try:
            # Create prompt for LLM assessment
            assessment_prompt = f"""
            Task: Rate how helpful this memory is for answering the given query on a scale of 1-10.

            Query: "{query}"

            Memory: "{memory}"

            Please provide:
            1. A score from 1-10 (where 10 = extremely helpful, 1 = not helpful at all)
            2. A brief reason for your score

            Format your response as:
            Score: [number]
            Reason: [your explanation]

            Consider:
            - Direct relevance to the query
            - Information completeness
            - How directly it answers the question
            - Whether it provides useful context or background
            """

            # Use the chat LLM to get assessment
            messages = [{"role": "user", "content": assessment_prompt}]
            response = self.chat_llm.generate(messages)

            # Parse the response to extract score and reason
            lines = response.strip().split("\n")
            score = 5  # Default score
            reason = "LLM assessment failed, using default score"

            for line in lines:
                if line.startswith("Score:"):
                    try:
                        score_text = line.split(":")[1].strip()
                        score = int(score_text)
                        score = max(1, min(10, score))  # Ensure score is 1-10
                    except Exception:
                        pass
                elif line.startswith("Reason:"):
                    reason = line.split(":", 1)[1].strip()

            return {"score": score, "reason": reason}

        except Exception as e:
            logger.warning(f"LLM assessment failed: {e}, using fallback scoring")
            # Fallback to simple keyword matching if LLM fails
            return self._fallback_memory_assessment(query, memory)

    def _fallback_memory_assessment(self, query: str, memory: str) -> dict:
        """Fallback assessment method using keyword matching if LLM fails"""
        query_lower = query.lower()
        memory_lower = memory.lower()

        # Keyword matching
        query_words = set(query_lower.split())
        memory_words = set(memory_lower.split())
        common_words = query_words.intersection(memory_words)

        # Semantic relevance scoring
        score = 0

        # Exact keyword matches (highest weight)
        if len(common_words) > 0:
            score += min(len(common_words) * 2, 6)

        # Partial matches (medium weight)
        partial_matches = sum(
            1 for qw in query_words for mw in memory_words if qw in mw or mw in qw
        )
        if partial_matches > 0:
            score += min(partial_matches, 3)

        # Topic relevance (through common topic words)
        topic_words = [
            "problem",
            "solution",
            "answer",
            "method",
            "reason",
            "result",
            "analysis",
            "compare",
            "explain",
        ]
        topic_matches = sum(1 for topic in topic_words if topic in memory_lower)
        score += topic_matches

        # Ensure score is 1-10
        score = max(1, min(10, score))

        # Determine helpfulness level
        if score >= 8:
            reason = "Highly relevant, directly answers the query"
        elif score >= 6:
            reason = "Relevant, provides useful information"
        elif score >= 4:
            reason = "Partially relevant, somewhat helpful"
        elif score >= 2:
            reason = "Low relevance, limited help"
        else:
            reason = "Very low relevance, minimal help"

        return {"score": score, "reason": reason}

    def _assess_ranking_quality(self, rank: int, helpfulness: int) -> str:
        """Use LLM to assess whether the memory ranking is reasonable"""
        try:
            # Create prompt for LLM ranking assessment
            ranking_prompt = f"""
            Task: Assess whether this memory ranking is reasonable.

            Context: A memory with helpfulness score {helpfulness}/10 is ranked at position {rank}.

            Please evaluate if this ranking makes sense and provide a brief assessment.

            Consider:
            - Higher helpfulness scores should generally rank higher
            - Rank 1 should typically have the highest helpfulness
            - The relationship between rank and helpfulness

            Provide a brief assessment in one sentence.
            """

            # Use the chat LLM to get assessment
            messages = [{"role": "user", "content": ranking_prompt}]
            response = self.chat_llm.generate(messages)

            return response.strip()

        except Exception as e:
            logger.warning(f"LLM ranking assessment failed: {e}, using fallback assessment")
            # Fallback assessment
            if rank == 1 and helpfulness >= 8:
                return "✅ Ranking is reasonable - most helpful memory ranked first"
            elif rank == 1 and helpfulness <= 4:
                return "❌ Ranking is unreasonable - first ranked memory has low helpfulness"
            elif rank <= 3 and helpfulness >= 6:
                return "✅ Ranking is reasonable - high helpfulness memory ranked high"
            elif rank <= 3 and helpfulness <= 3:
                return "⚠️  Ranking may be unreasonable - low helpfulness memory ranked high"
            elif rank > 3 and helpfulness >= 7:
                return "⚠️  Ranking may be unreasonable - high helpfulness memory ranked low"
            else:
                return "🟡 Ranking is acceptable - helpfulness and rank generally match"

    def chat(self, query: str, user_id: str | None = None) -> str:
        """
        Chat with the MOS with memory helpfulness analysis.

        Args:
            query (str): The user's query.
            user_id (str | None): The user ID.

        Returns:
            str: The response from the MOS.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        user_cube_ids = [cube.cube_id for cube in accessible_cubes]

        if target_user_id not in self.chat_history_manager:
            self._register_chat_history(target_user_id)

        chat_history = self.chat_history_manager[target_user_id]
        topk_for_scheduler = 2

        if self.config.enable_textual_memory and self.mem_cubes:
            memories_all = []
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if not mem_cube.text_mem:
                    continue

                # Get working memories BEFORE scheduler
                working_memories_before = [m.memory for m in mem_cube.text_mem.get_working_memory()]

                message_item = ScheduleMessageItem(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    label=QUERY_LABEL,
                    content=query,
                    timestamp=datetime.now(),
                )

                print(f"\n🚀 Starting Scheduler for {mem_cube_id}...")

                # Force scheduler to run immediately
                self.mem_scheduler.monitor.query_trigger_interval = 0
                self.mem_scheduler._query_message_consumer(messages=[message_item])

                # Get scheduler memories
                scheduler_memories = self.mem_scheduler.monitor.get_monitor_memories(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    memory_type=MONITOR_WORKING_MEMORY_TYPE,
                    top_k=20,
                )

                # Get working memories AFTER scheduler
                working_memories_after = [m.memory for m in mem_cube.text_mem.get_working_memory()]

                # Get mem_cube memories for response generation
                memories = mem_cube.text_mem.search(
                    query,
                    top_k=self.config.top_k - topk_for_scheduler,
                    info={
                        "user_id": target_user_id,
                        "session_id": self.session_id,
                        "chat_history": chat_history.chat_history,
                    },
                )
                text_memories = [m.memory for m in memories]

                # Analyze memory helpfulness - compare before vs after vs scheduler
                self._analyze_memory_helpfulness(
                    query, working_memories_before, working_memories_after, scheduler_memories
                )

                # Combine all memories for response generation
                memories_all.extend(scheduler_memories[:topk_for_scheduler])
                memories_all.extend(text_memories)
                memories_all = list(set(memories_all))

            logger.info(f"🧠 [Memory] Searched memories:\n{self._str_memories(memories_all)}\n")
            system_prompt = self._build_system_prompt(memories_all)
        else:
            system_prompt = self._build_system_prompt()

        current_messages = [
            {"role": "system", "content": system_prompt},
            *chat_history.chat_history,
            {"role": "user", "content": query},
        ]
        past_key_values = None

        if self.config.enable_activation_memory:
            assert self.config.chat_model.backend == "huggingface", (
                "Activation memory only used for huggingface backend."
            )
            # TODO this only one cubes
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if mem_cube.act_mem:
                    kv_cache = next(iter(mem_cube.act_mem.get_all()), None)
                    past_key_values = (
                        kv_cache.memory if (kv_cache and hasattr(kv_cache, "memory")) else None
                    )
                    break
            # Generate response
            response = self.chat_llm.generate(current_messages, past_key_values=past_key_values)
        else:
            response = self.chat_llm.generate(current_messages)

        logger.info(f"🤖 [Assistant] {response}\n")
        chat_history.chat_history.append({"role": "user", "content": query})
        chat_history.chat_history.append({"role": "assistant", "content": response})
        self.chat_history_manager[user_id] = chat_history

        # Submit message to scheduler for answer processing
        for accessible_mem_cube in accessible_cubes:
            mem_cube_id = accessible_mem_cube.cube_id
            mem_cube = self.mem_cubes[mem_cube_id]
            if self.enable_mem_scheduler and self.mem_scheduler is not None:
                message_item = ScheduleMessageItem(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    label=ANSWER_LABEL,
                    content=response,
                    timestamp=datetime.now(),
                )
                self.mem_scheduler.submit_messages(messages=[message_item])

        return response

    def get_memory_helpfulness_summary(self) -> dict:
        """Get summary of memory helpfulness analysis."""
        if not self.memory_helpfulness_analysis:
            return {"message": "No memory helpfulness analysis data available"}

        total_queries = len(self.memory_helpfulness_analysis)

        # Calculate average helpfulness for working memories before scheduler
        before_scores = []
        for analysis in self.memory_helpfulness_analysis:
            before_scores.extend(analysis["working_helpfulness_before"])

        # Calculate average helpfulness for working memories after scheduler
        after_scores = []
        for analysis in self.memory_helpfulness_analysis:
            after_scores.extend(analysis["working_helpfulness_after"])

        # Calculate average helpfulness for scheduler memories from monitor
        scheduler_scores = []
        for analysis in self.memory_helpfulness_analysis:
            scheduler_scores.extend(analysis["scheduler_helpfulness"])

        avg_before_helpfulness = sum(before_scores) / len(before_scores) if before_scores else 0
        avg_after_helpfulness = sum(after_scores) / len(after_scores) if after_scores else 0
        avg_scheduler_helpfulness = (
            sum(scheduler_scores) / len(scheduler_scores) if scheduler_scores else 0
        )

        return {
            "total_queries": total_queries,
            "working_memories_before_analyzed": len(before_scores),
            "working_memories_after_analyzed": len(after_scores),
            "scheduler_memories_analyzed": len(scheduler_scores),
            "average_helpfulness_before_scheduler": f"{avg_before_helpfulness:.1f}/10",
            "average_helpfulness_after_scheduler": f"{avg_after_helpfulness:.1f}/10",
            "average_helpfulness_scheduler_memories": f"{avg_scheduler_helpfulness:.1f}/10",
            "overall_improvement": f"{avg_after_helpfulness - avg_before_helpfulness:+.1f}",
            "improvement_percentage": f"{((avg_after_helpfulness - avg_before_helpfulness) / avg_before_helpfulness * 100):+.1f}%"
            if avg_before_helpfulness > 0
            else "N/A",
            "scheduler_vs_working_comparison": f"{avg_scheduler_helpfulness - avg_after_helpfulness:+.1f}",
        }

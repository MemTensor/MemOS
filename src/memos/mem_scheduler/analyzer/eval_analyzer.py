"""
Evaluation Analyzer for Bad Cases

This module provides the EvalAnalyzer class that extracts bad cases from evaluation results
and analyzes whether memories contain sufficient information to answer golden answers.
"""

import json
import os
import sys

from pathlib import Path
from typing import Any

from openai import OpenAI

from memos.api.routers.server_router import mem_scheduler
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryMetadata
from memos.memories.textual.tree import TextualMemoryItem


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent.parent.parent  # Go up to project root
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


class EvalAnalyzer:
    """
    Evaluation Analyzer class for extracting and analyzing bad cases.

    This class extracts bad cases from evaluation results and uses LLM to analyze
    whether memories contain sufficient information to answer golden answers.
    """

    def __init__(
        self,
        openai_api_key: str | None = None,
        openai_base_url: str | None = None,
        openai_model: str = "gpt-4o-mini",
        output_dir: str = "./tmp/eval_analyzer",
    ):
        """
        Initialize the EvalAnalyzer.

        Args:
            openai_api_key: OpenAI API key
            openai_base_url: OpenAI base URL
            openai_model: OpenAI model to use
            output_dir: Output directory for results
        """
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Initialize OpenAI client
        self.openai_client = OpenAI(
            api_key=openai_api_key or os.getenv("MEMSCHEDULER_OPENAI_API_KEY"),
            base_url=openai_base_url or os.getenv("MEMSCHEDULER_OPENAI_BASE_URL"),
        )
        self.openai_model = openai_model or os.getenv(
            "MEMSCHEDULER_OPENAI_DEFAULT_MODEL", "gpt-4o-mini"
        )

        logger.info(f"EvalAnalyzer initialized with model: {self.openai_model}")

    def load_json_file(self, filepath: str) -> Any:
        """Load JSON file safely."""
        try:
            with open(filepath, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            logger.error(f"File not found: {filepath}")
            return None
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error in {filepath}: {e}")
            return None

    def extract_bad_cases(self, judged_file: str, search_results_file: str) -> list[dict[str, Any]]:
        """
        Extract bad cases from judged results and corresponding search results.

        Args:
            judged_file: Path to the judged results JSON file
            search_results_file: Path to the search results JSON file

        Returns:
            List of bad cases with their memories
        """
        logger.info(f"Loading judged results from: {judged_file}")
        judged_data = self.load_json_file(judged_file)
        if not judged_data:
            return []

        logger.info(f"Loading search results from: {search_results_file}")
        search_data = self.load_json_file(search_results_file)
        if not search_data:
            return []

        bad_cases = []

        # Process each user's data
        for user_id, user_judged_results in judged_data.items():
            user_search_results = search_data.get(user_id, [])

            # Create a mapping from query to search context
            search_context_map = {}
            for search_result in user_search_results:
                query = search_result.get("query", "")
                context = search_result.get("context", "")
                search_context_map[query] = context

            # Process each question for this user
            for result in user_judged_results:
                # Check if this is a bad case (all judgments are False)
                judgments = result.get("llm_judgments", {})
                is_bad_case = all(not judgment for judgment in judgments.values())

                if is_bad_case:
                    question = result.get("question", "")
                    answer = result.get("answer", "")
                    golden_answer = result.get("golden_answer", "")

                    # Find corresponding memories from search results
                    memories = search_context_map.get(question, "")

                    bad_case = {
                        "user_id": user_id,
                        "query": question,
                        "answer": answer,
                        "golden_answer": golden_answer,
                        "memories": memories,
                        "category": result.get("category", 0),
                        "nlp_metrics": result.get("nlp_metrics", {}),
                        "response_duration_ms": result.get("response_duration_ms", 0),
                        "search_duration_ms": result.get("search_duration_ms", 0),
                        "total_duration_ms": result.get("total_duration_ms", 0),
                    }

                    bad_cases.append(bad_case)

        logger.info(f"Extracted {len(bad_cases)} bad cases")
        return bad_cases

    def analyze_memory_sufficiency(
        self, query: str, golden_answer: str, memories: str
    ) -> dict[str, Any]:
        """
        Use LLM to analyze whether memories contain sufficient information to answer the golden answer.

        Args:
            query: The original query
            golden_answer: The correct answer
            memories: The memory context

        Returns:
            Analysis result containing sufficiency judgment and relevant memory indices
        """
        prompt = f"""
You are an expert analyst tasked with determining whether the provided memories contain sufficient information to answer a specific question correctly.

**Question:** {query}

**Golden Answer (Correct Answer):** {golden_answer}

**Available Memories:**
{memories}

**Task:**
1. Analyze whether the memories contain enough information to derive the golden answer
2. Identify which specific memory entries (if any) contain relevant information
3. Provide a clear judgment: True if sufficient, False if insufficient

**Response Format (JSON):**
{{
    "sufficient": true/false,
    "confidence": 0.0-1.0,
    "relevant_memories": ["memory_1", "memory_2", ...],
    "reasoning": "Detailed explanation of your analysis",
    "missing_information": "What key information is missing (if insufficient)"
}}

**Guidelines:**
- Be strict in your evaluation - only mark as sufficient if the memories clearly contain the information needed
- Consider both direct and indirect information that could lead to the golden answer
- Pay attention to dates, names, events, and specific details
- If information is ambiguous or requires significant inference, lean towards insufficient
"""

        try:
            response = self.openai_client.chat.completions.create(
                model=self.openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a precise analyst who evaluates information sufficiency.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=1000,
            )

            content = response.choices[0].message.content.strip()

            # Try to parse JSON response
            try:
                # Remove markdown code blocks if present
                if content.startswith("```json"):
                    content = content[7:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

                analysis = json.loads(content)
                return analysis

            except json.JSONDecodeError:
                logger.warning(f"Failed to parse LLM response as JSON: {content}")
                return {
                    "sufficient": False,
                    "confidence": 0.0,
                    "relevant_memories": [],
                    "reasoning": f"Failed to parse LLM response: {content}",
                    "missing_information": "Analysis failed",
                }

        except Exception as e:
            logger.error(f"Error in LLM analysis: {e}")
            return {
                "sufficient": False,
                "confidence": 0.0,
                "relevant_memories": [],
                "reasoning": f"Error occurred: {e!s}",
                "missing_information": "Analysis failed due to error",
            }

    def process_memories_with_llm(
        self, memories: str, query: str, processing_type: str = "summarize"
    ) -> dict[str, Any]:
        """
        Use LLM to process memories for better question answering.

        Args:
            memories: The raw memory content
            query: The query that will be answered using these memories
            processing_type: Type of processing ("summarize", "restructure", "enhance")

        Returns:
            Dictionary containing processed memories and processing metadata
        """
        if processing_type == "summarize":
            prompt = f"""
You are an expert at summarizing and organizing information to help answer specific questions.

**Target Question:** {query}

**Raw Memories:**
{memories}

**Task:**
Summarize and organize the above memories in a way that would be most helpful for answering the target question. Focus on:
1. Key facts and information relevant to the question
2. Important relationships and connections
3. Chronological or logical organization where applicable
4. Remove redundant or irrelevant information

**Processed Memories:**
"""
        elif processing_type == "restructure":
            prompt = f"""
You are an expert at restructuring information to optimize question answering.

**Target Question:** {query}

**Raw Memories:**
{memories}

**Task:**
Restructure the above memories into a clear, logical format that directly supports answering the target question. Organize by:
1. Most relevant information first
2. Supporting details and context
3. Clear categorization of different types of information
4. Logical flow that leads to the answer

**Restructured Memories:**
"""
        elif processing_type == "enhance":
            prompt = f"""
You are an expert at enhancing information by adding context and making connections.

**Target Question:** {query}

**Raw Memories:**
{memories}

**Task:**
Enhance the above memories by:
1. Making implicit connections explicit
2. Adding relevant context that helps answer the question
3. Highlighting key relationships between different pieces of information
4. Organizing information in a question-focused manner

**Enhanced Memories:**
"""
        else:
            raise ValueError(f"Unknown processing_type: {processing_type}")

        try:
            response = self.openai_client.chat.completions.create(
                model=self.openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert information processor who optimizes content for question answering.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                max_tokens=2000,
            )

            processed_memories = response.choices[0].message.content.strip()

            return {
                "processed_memories": processed_memories,
                "processing_type": processing_type,
                "original_length": len(memories),
                "processed_length": len(processed_memories),
                "compression_ratio": len(processed_memories) / len(memories)
                if len(memories) > 0
                else 0,
            }

        except Exception as e:
            logger.error(f"Error in memory processing: {e}")
            return {
                "processed_memories": memories,  # Fallback to original
                "processing_type": processing_type,
                "original_length": len(memories),
                "processed_length": len(memories),
                "compression_ratio": 1.0,
                "error": str(e),
            }

    def generate_answer_with_memories(
        self, query: str, memories: str, memory_type: str = "original"
    ) -> dict[str, Any]:
        """
        Generate an answer to the query using the provided memories.

        Args:
            query: The question to answer
            memories: The memory content to use
            memory_type: Type of memories ("original", "processed")

        Returns:
            Dictionary containing the generated answer and metadata
        """
        prompt = f"""
 You are a knowledgeable and helpful AI assistant.

   # CONTEXT:
   You have access to memories from two speakers in a conversation. These memories contain
   timestamped information that may be relevant to answering the question.

   # INSTRUCTIONS:
   1. Carefully analyze all provided memories. Synthesize information across different entries if needed to form a complete answer.
   2. Pay close attention to the timestamps to determine the answer. If memories contain contradictory information, the **most recent memory** is the source of truth.
   3. If the question asks about a specific event or fact, look for direct evidence in the memories.
   4. Your answer must be grounded in the memories. However, you may use general world knowledge to interpret or complete information found within a memory (e.g., identifying a landmark mentioned by description).
   5. If the question involves time references (like "last year", "two months ago", etc.), you **must** calculate the actual date based on the memory's timestamp. For example, if a memory from 4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
   6. Always convert relative time references to specific dates, months, or years in your final answer.
   7. Do not confuse character names mentioned in memories with the actual users who created them.
   8. The answer must be brief (under 5-6 words) and direct, with no extra description.

   # APPROACH (Think step by step):
   1. First, examine all memories that contain information related to the question.
   2. Synthesize findings from multiple memories if a single entry is insufficient.
   3. Examine timestamps and content carefully, looking for explicit dates, times, locations, or events.
   4. If the answer requires calculation (e.g., converting relative time references), perform the calculation.
   5. Formulate a precise, concise answer based on the evidence from the memories (and allowed world knowledge).
   6. Double-check that your answer directly addresses the question asked and adheres to all instructions.
   7. Ensure your final answer is specific and avoids vague time references.

   {memories}

   Question: {query}

   Answer:
"""

        try:
            response = self.openai_client.chat.completions.create(
                model=self.openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a precise assistant who answers questions based only on provided information.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=1000,
            )

            answer = response.choices[0].message.content.strip()

            return {
                "answer": answer,
                "memory_type": memory_type,
                "query": query,
                "memory_length": len(memories),
                "answer_length": len(answer),
            }

        except Exception as e:
            logger.error(f"Error in answer generation: {e}")
            return {
                "answer": f"Error generating answer: {e!s}",
                "memory_type": memory_type,
                "query": query,
                "memory_length": len(memories),
                "answer_length": 0,
                "error": str(e),
            }

    def compare_answer_quality(
        self, query: str, golden_answer: str, original_answer: str, processed_answer: str
    ) -> dict[str, Any]:
        """
        Compare the quality of answers generated from original vs processed memories.

        Args:
            query: The original query
            golden_answer: The correct/expected answer
            original_answer: Answer generated from original memories
            processed_answer: Answer generated from processed memories

        Returns:
            Dictionary containing comparison results
        """
        prompt = f"""
You are an expert evaluator comparing the quality of two answers against a golden standard.

**Question:** {query}

**Golden Answer (Correct):** {golden_answer}

**Answer A (Original Memories):** {original_answer}

**Answer B (Processed Memories):** {processed_answer}

**Task:**
Compare both answers against the golden answer and evaluate:
1. Accuracy: How correct is each answer?
2. Completeness: How complete is each answer?
3. Relevance: How relevant is each answer to the question?
4. Clarity: How clear and well-structured is each answer?

**Response Format (JSON):**
{{
    "original_scores": {{
        "accuracy": 0.0-1.0,
        "completeness": 0.0-1.0,
        "relevance": 0.0-1.0,
        "clarity": 0.0-1.0,
        "overall": 0.0-1.0
    }},
    "processed_scores": {{
        "accuracy": 0.0-1.0,
        "completeness": 0.0-1.0,
        "relevance": 0.0-1.0,
        "clarity": 0.0-1.0,
        "overall": 0.0-1.0
    }},
    "winner": "original|processed|tie",
    "improvement": 0.0-1.0,
    "reasoning": "Detailed explanation of the comparison"
}}
"""

        try:
            response = self.openai_client.chat.completions.create(
                model=self.openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert evaluator who compares answer quality objectively.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=1500,
            )

            content = response.choices[0].message.content.strip()

            # Try to parse JSON response
            try:
                if content.startswith("```json"):
                    content = content[7:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

                comparison = json.loads(content)
                return comparison

            except json.JSONDecodeError:
                logger.warning(f"Failed to parse comparison response as JSON: {content}")
                return {
                    "original_scores": {
                        "accuracy": 0.5,
                        "completeness": 0.5,
                        "relevance": 0.5,
                        "clarity": 0.5,
                        "overall": 0.5,
                    },
                    "processed_scores": {
                        "accuracy": 0.5,
                        "completeness": 0.5,
                        "relevance": 0.5,
                        "clarity": 0.5,
                        "overall": 0.5,
                    },
                    "winner": "tie",
                    "improvement": 0.0,
                    "reasoning": f"Failed to parse comparison: {content}",
                }

        except Exception as e:
            logger.error(f"Error in answer comparison: {e}")
            return {
                "original_scores": {
                    "accuracy": 0.0,
                    "completeness": 0.0,
                    "relevance": 0.0,
                    "clarity": 0.0,
                    "overall": 0.0,
                },
                "processed_scores": {
                    "accuracy": 0.0,
                    "completeness": 0.0,
                    "relevance": 0.0,
                    "clarity": 0.0,
                    "overall": 0.0,
                },
                "winner": "tie",
                "improvement": 0.0,
                "reasoning": f"Error occurred: {e!s}",
            }

    def analyze_memory_processing_effectiveness(
        self,
        bad_cases: list[dict[str, Any]],
        processing_types: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Analyze the effectiveness of different memory processing techniques.

        Args:
            bad_cases: List of bad cases to analyze
            processing_types: List of processing types to test

        Returns:
            Dictionary containing comprehensive analysis results
        """
        if processing_types is None:
            processing_types = ["summarize", "restructure", "enhance"]
        results = {"processing_results": [], "statistics": {}, "processing_types": processing_types}

        for i, case in enumerate(bad_cases):
            logger.info(f"Processing case {i + 1}/{len(bad_cases)}: {case['query'][:50]}...")

            case_result = {
                "case_id": i,
                "query": case["query"],
                "golden_answer": case["golden_answer"],
                "original_memories": case["memories"],
                "processing_results": {},
            }

            # Generate answer with original memories
            original_answer_result = self.generate_answer_with_memories(
                case["query"], case["memories"], "original"
            )
            case_result["original_answer"] = original_answer_result

            # Test each processing type
            for processing_type in processing_types:
                logger.info(f"  Testing {processing_type} processing...")

                # Process memories
                processing_result = self.process_memories_with_llm(
                    case["memories"], case["query"], processing_type
                )

                # Generate answer with processed memories
                processed_answer_result = self.generate_answer_with_memories(
                    case["query"],
                    processing_result["processed_memories"],
                    f"processed_{processing_type}",
                )

                # Compare answer quality
                comparison_result = self.compare_answer_quality(
                    case["query"],
                    case["golden_answer"],
                    original_answer_result["answer"],
                    processed_answer_result["answer"],
                )

                case_result["processing_results"][processing_type] = {
                    "processing": processing_result,
                    "answer": processed_answer_result,
                    "comparison": comparison_result,
                }

            results["processing_results"].append(case_result)

        # Calculate statistics
        self._calculate_processing_statistics(results)

        return results

    def _calculate_processing_statistics(self, results: dict[str, Any]) -> None:
        """Calculate statistics for processing effectiveness analysis."""
        processing_types = results["processing_types"]
        processing_results = results["processing_results"]

        if not processing_results:
            results["statistics"] = {}
            return

        stats = {"total_cases": len(processing_results), "processing_type_stats": {}}

        for processing_type in processing_types:
            type_stats = {
                "wins": 0,
                "ties": 0,
                "losses": 0,
                "avg_improvement": 0.0,
                "avg_compression_ratio": 0.0,
                "avg_scores": {
                    "accuracy": 0.0,
                    "completeness": 0.0,
                    "relevance": 0.0,
                    "clarity": 0.0,
                    "overall": 0.0,
                },
            }

            valid_cases = []
            for case in processing_results:
                if processing_type in case["processing_results"]:
                    result = case["processing_results"][processing_type]
                    comparison = result["comparison"]

                    # Count wins/ties/losses
                    if comparison["winner"] == "processed":
                        type_stats["wins"] += 1
                    elif comparison["winner"] == "tie":
                        type_stats["ties"] += 1
                    else:
                        type_stats["losses"] += 1

                    valid_cases.append(result)

            if valid_cases:
                # Calculate averages
                type_stats["avg_improvement"] = sum(
                    case["comparison"]["improvement"] for case in valid_cases
                ) / len(valid_cases)

                type_stats["avg_compression_ratio"] = sum(
                    case["processing"]["compression_ratio"] for case in valid_cases
                ) / len(valid_cases)

                # Calculate average scores
                for score_type in type_stats["avg_scores"]:
                    type_stats["avg_scores"][score_type] = sum(
                        case["comparison"]["processed_scores"][score_type] for case in valid_cases
                    ) / len(valid_cases)

                # Calculate win rate
                total_decisions = type_stats["wins"] + type_stats["ties"] + type_stats["losses"]
                type_stats["win_rate"] = (
                    type_stats["wins"] / total_decisions if total_decisions > 0 else 0.0
                )
                type_stats["success_rate"] = (
                    (type_stats["wins"] + type_stats["ties"]) / total_decisions
                    if total_decisions > 0
                    else 0.0
                )

            stats["processing_type_stats"][processing_type] = type_stats

        results["statistics"] = stats

    def analyze_bad_cases(self, bad_cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Analyze all bad cases to determine memory sufficiency.

        Args:
            bad_cases: List of bad cases to analyze

        Returns:
            List of analyzed bad cases with sufficiency information
        """
        analyzed_cases = []

        for i, case in enumerate(bad_cases):
            logger.info(f"Analyzing bad case {i + 1}/{len(bad_cases)}: {case['query'][:50]}...")

            analysis = self.analyze_memory_sufficiency(
                case["query"], case["golden_answer"], case["memories"]
            )

            # Add analysis results to the case
            analyzed_case = case.copy()
            analyzed_case.update(
                {
                    "memory_analysis": analysis,
                    "has_sufficient_memories": analysis["sufficient"],
                    "analysis_confidence": analysis["confidence"],
                    "relevant_memory_count": len(analysis["relevant_memories"]),
                }
            )

            analyzed_cases.append(analyzed_case)

        return analyzed_cases

    def collect_bad_cases(self, eval_result_dir: str | None = None) -> dict[str, Any]:
        """
        Main method to collect and analyze bad cases from evaluation results.

        Args:
            eval_result_dir: Directory containing evaluation results

        Returns:
            Dictionary containing analysis results and statistics
        """
        if eval_result_dir is None:
            eval_result_dir = f"{BASE_DIR}/evaluation/results/locomo/memos-api-072005-fast"

        judged_file = os.path.join(eval_result_dir, "memos-api_locomo_judged.json")
        search_results_file = os.path.join(eval_result_dir, "memos-api_locomo_search_results.json")

        # Extract bad cases
        bad_cases = self.extract_bad_cases(judged_file, search_results_file)

        if not bad_cases:
            logger.warning("No bad cases found")
            return {"bad_cases": [], "statistics": {}}

        # Analyze bad cases
        analyzed_cases = self.analyze_bad_cases(bad_cases)

        # Calculate statistics
        total_cases = len(analyzed_cases)
        sufficient_cases = sum(
            1 for case in analyzed_cases if case.get("has_sufficient_memories", False)
        )
        insufficient_cases = total_cases - sufficient_cases

        avg_confidence = (
            sum(case["analysis_confidence"] for case in analyzed_cases) / total_cases
            if total_cases > 0
            else 0
        )
        avg_relevant_memories = (
            sum(case["relevant_memory_count"] for case in analyzed_cases) / total_cases
            if total_cases > 0
            else 0
        )

        statistics = {
            "total_bad_cases": total_cases,
            "sufficient_memory_cases": sufficient_cases,
            "insufficient_memory_cases": insufficient_cases,
            "sufficiency_rate": sufficient_cases / total_cases if total_cases > 0 else 0,
            "average_confidence": avg_confidence,
            "average_relevant_memories": avg_relevant_memories,
        }

        # Save results
        results = {
            "bad_cases": analyzed_cases,
            "statistics": statistics,
            "metadata": {
                "eval_result_dir": eval_result_dir,
                "judged_file": judged_file,
                "search_results_file": search_results_file,
                "analysis_model": self.openai_model,
            },
        }

        output_file = self.output_dir / "bad_cases_analysis.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)

        logger.info(f"Analysis complete. Results saved to: {output_file}")
        logger.info(f"Statistics: {statistics}")

        return results

    def _parse_json_response(self, response_text: str) -> dict:
        """
        Parse JSON response from LLM, handling various formats and potential errors.

        Args:
            response_text: Raw response text from LLM

        Returns:
            Parsed JSON dictionary

        Raises:
            ValueError: If JSON cannot be parsed
        """
        import re

        # Try to extract JSON from response text
        # Look for JSON blocks between ```json and ``` or just {} blocks
        json_patterns = [r"```json\s*(\{.*?\})\s*```", r"```\s*(\{.*?\})\s*```", r"(\{.*\})"]

        for pattern in json_patterns:
            matches = re.findall(pattern, response_text, re.DOTALL)
            if matches:
                json_str = matches[0].strip()
                try:
                    return json.loads(json_str)
                except json.JSONDecodeError:
                    continue

        # If no JSON pattern found, try parsing the entire response
        try:
            return json.loads(response_text.strip())
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON response: {response_text[:200]}...")
            raise ValueError(f"Invalid JSON response: {e!s}") from e

    def filter_memories_with_llm(self, memories: list[str], query: str) -> tuple[list[str], bool]:
        """
        Use LLM to filter memories based on relevance to the query.

        Args:
            memories: List of memory strings
            query: Query to filter memories against

        Returns:
            Tuple of (filtered_memories, success_flag)
        """
        if not memories:
            return [], True

        # Build prompt for memory filtering
        memories_text = "\n".join([f"{i + 1}. {memory}" for i, memory in enumerate(memories)])

        prompt = f"""You are a memory filtering system. Given a query and a list of memories, identify which memories are relevant and non-redundant for answering the query.

Query: {query}

Memories:
{memories_text}

Please analyze each memory and return a JSON response with the following format:
{{
    "relevant_memory_indices": [list of indices (1-based) of memories that are relevant to the query],
    "reasoning": "Brief explanation of your filtering decisions"
}}

Only include memories that are directly relevant to answering the query. Remove redundant or unrelated memories."""

        try:
            response = self.openai_client.chat.completions.create(
                model=self.openai_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )

            response_text = response.choices[0].message.content

            # Extract JSON from response
            result = self._parse_json_response(response_text)

            if "relevant_memory_indices" in result:
                relevant_indices = result["relevant_memory_indices"]
                filtered_memories = []

                for idx in relevant_indices:
                    if 1 <= idx <= len(memories):
                        filtered_memories.append(memories[idx - 1])

                logger.info(f"Filtered memories: {len(memories)} -> {len(filtered_memories)}")
                return filtered_memories, True
            else:
                logger.warning("Invalid response format from memory filtering LLM")
                return memories, False

        except Exception as e:
            logger.error(f"Error in memory filtering: {e}")
            return memories, False

    def evaluate_answer_ability_with_llm(self, query: str, memories: list[str]) -> bool:
        """
        Use LLM to evaluate whether the given memories can answer the query.

        Args:
            query: Query to evaluate
            memories: List of memory strings

        Returns:
            Boolean indicating whether memories can answer the query
        """
        if not memories:
            return False

        memories_text = "\n".join([f"- {memory}" for memory in memories])

        prompt = f"""You are an answer ability evaluator. Given a query and a list of memories, determine whether the memories contain sufficient information to answer the query.

Query: {query}

Available Memories:
{memories_text}

Please analyze the memories and return a JSON response with the following format:
{{
    "can_answer": true/false,
    "confidence": 0.0-1.0,
    "reasoning": "Brief explanation of your decision"
}}

Consider whether the memories contain the specific information needed to provide a complete and accurate answer to the query."""

        try:
            response = self.openai_client.chat.completions.create(
                model=self.openai_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )

            response_text = response.choices[0].message.content
            result = self._parse_json_response(response_text)

            if "can_answer" in result:
                can_answer = result["can_answer"]
                confidence = result.get("confidence", 0.5)
                reasoning = result.get("reasoning", "No reasoning provided")

                logger.info(
                    f"Answer ability evaluation: {can_answer} (confidence: {confidence:.2f}) - {reasoning}"
                )
                return can_answer
            else:
                logger.warning("Invalid response format from answer ability evaluation")
                return False

        except Exception as e:
            logger.error(f"Error in answer ability evaluation: {e}")
            return False

    def memory_llm_processing_analysis(
        self, bad_cases: list[dict[str, Any]], use_llm_filtering: bool = True
    ) -> list[dict[str, Any]]:
        """
        Analyze bad cases by processing memories with LLM filtering and testing answer ability.

        This method:
        1. Parses memory strings from bad cases
        2. Uses LLM to filter unrelated and redundant memories
        3. Tests whether processed memories can help answer questions correctly
        4. Compares results before and after LLM processing

        Args:
            bad_cases: List of bad cases to analyze
            use_llm_filtering: Whether to use LLM filtering

        Returns:
            List of analyzed bad cases with LLM processing results
        """
        analyzed_cases = []

        for i, case in enumerate(bad_cases):
            logger.info(f"Processing bad case {i + 1}/{len(bad_cases)}: {case['query'][:50]}...")

            try:
                # Parse memory string
                memories_text = case.get("memories", "")
                if not memories_text:
                    logger.warning(f"No memories found for case {i + 1}")
                    analyzed_case = case.copy()
                    analyzed_case.update(
                        {
                            "llm_processing_analysis": {
                                "error": "No memories available",
                                "original_memories_count": 0,
                                "processed_memories_count": 0,
                                "can_answer_with_original": False,
                                "can_answer_with_processed": False,
                                "processing_improved_answer": False,
                            }
                        }
                    )
                    analyzed_cases.append(analyzed_case)
                    continue

                # Split memories by lines
                memory_lines = [line.strip() for line in memories_text.split("\n") if line.strip()]
                original_memories = [line for line in memory_lines if line]

                logger.info(f"Parsed {len(original_memories)} memories from text")

                # Test answer ability with original memories
                can_answer_original = self.evaluate_answer_ability_with_llm(
                    query=case["query"], memories=original_memories
                )

                # Process memories with LLM filtering if enabled
                processed_memories = original_memories
                processing_success = False

                if use_llm_filtering and len(original_memories) > 0:
                    processed_memories, processing_success = self.filter_memories_with_llm(
                        memories=original_memories, query=case["query"]
                    )
                    logger.info(
                        f"LLM filtering: {len(original_memories)} -> {len(processed_memories)} memories, success: {processing_success}"
                    )

                # Test answer ability with processed memories
                can_answer_processed = self.evaluate_answer_ability_with_llm(
                    query=case["query"], memories=processed_memories
                )

                # Determine if processing improved answer ability
                processing_improved = can_answer_processed and not can_answer_original

                # Create analysis result
                llm_analysis = {
                    "processing_success": processing_success,
                    "original_memories_count": len(original_memories),
                    "processed_memories_count": len(processed_memories),
                    "memories_removed_count": len(original_memories) - len(processed_memories),
                    "can_answer_with_original": can_answer_original,
                    "can_answer_with_processed": can_answer_processed,
                    "processing_improved_answer": processing_improved,
                    "original_memories": original_memories,
                    "processed_memories": processed_memories,
                }

                # Add analysis to case
                analyzed_case = case.copy()
                analyzed_case["llm_processing_analysis"] = llm_analysis

                logger.info(
                    f"Case {i + 1} analysis complete: "
                    f"Original: {can_answer_original}, "
                    f"Processed: {can_answer_processed}, "
                    f"Improved: {processing_improved}"
                )

            except Exception as e:
                logger.error(f"Error processing case {i + 1}: {e}")
                analyzed_case = case.copy()
                analyzed_case["llm_processing_analysis"] = {
                    "error": str(e),
                    "processing_success": False,
                    "original_memories_count": 0,
                    "processed_memories_count": 0,
                    "can_answer_with_original": False,
                    "can_answer_with_processed": False,
                    "processing_improved_answer": False,
                }

            analyzed_cases.append(analyzed_case)

        return analyzed_cases

    def scheduler_mem_process(self, query, memories):
        from memos.mem_scheduler.utils.misc_utils import extract_list_items_in_answer

        _memories = []
        for mem in memories:
            mem_item = TextualMemoryItem(memory=mem, metadata=TextualMemoryMetadata())
            _memories.append(mem_item)
        prompt = mem_scheduler.retriever._build_enhancement_prompt(
            query_history=[query], batch_texts=memories
        )
        logger.debug(
            f"[Enhance][batch={0}] Prompt (first 200 chars, len={len(prompt)}): {prompt[:200]}..."
        )

        response = mem_scheduler.retriever.process_llm.generate(
            [{"role": "user", "content": prompt}]
        )
        logger.debug(f"[Enhance][batch={0}] Response (first 200 chars): {response[:200]}...")

        processed_results = extract_list_items_in_answer(response)

        return {
            "processed_memories": processed_results,
            "processing_type": "enhance",
            "original_length": len("\n".join(memories)),
            "processed_length": len("\n".join(processed_results)),
            "compression_ratio": len("\n".join(processed_results)) / len("\n".join(memories))
            if len(memories) > 0
            else 0,
        }

    def analyze_bad_cases_with_llm_processing(
        self,
        bad_cases: list[dict[str, Any]],
        save_results: bool = True,
        output_file: str | None = None,
    ) -> dict[str, Any]:
        """
        Comprehensive analysis of bad cases with LLM memory processing.

        This method performs a complete analysis including:
        1. Basic bad case analysis
        2. LLM memory processing analysis
        3. Statistical summary of improvements
        4. Detailed reporting

        Args:
            bad_cases: List of bad cases to analyze
            save_results: Whether to save results to file
            output_file: Optional output file path

        Returns:
            Dictionary containing comprehensive analysis results
        """
        from datetime import datetime

        logger.info(
            f"Starting comprehensive analysis of {len(bad_cases)} bad cases with LLM processing"
        )

        # Perform LLM memory processing analysis
        analyzed_cases = self.memory_llm_processing_analysis(
            bad_cases=bad_cases, use_llm_filtering=True
        )

        # Calculate statistics
        total_cases = len(analyzed_cases)
        successful_processing = 0
        improved_cases = 0
        original_answerable = 0
        processed_answerable = 0
        total_memories_before = 0
        total_memories_after = 0

        for case in analyzed_cases:
            llm_analysis = case.get("llm_processing_analysis", {})

            if llm_analysis.get("processing_success", False):
                successful_processing += 1

            if llm_analysis.get("processing_improved_answer", False):
                improved_cases += 1

            if llm_analysis.get("can_answer_with_original", False):
                original_answerable += 1

            if llm_analysis.get("can_answer_with_processed", False):
                processed_answerable += 1

            total_memories_before += llm_analysis.get("original_memories_count", 0)
            total_memories_after += llm_analysis.get("processed_memories_count", 0)

        # Calculate improvement metrics
        processing_success_rate = successful_processing / total_cases if total_cases > 0 else 0
        improvement_rate = improved_cases / total_cases if total_cases > 0 else 0
        original_answer_rate = original_answerable / total_cases if total_cases > 0 else 0
        processed_answer_rate = processed_answerable / total_cases if total_cases > 0 else 0
        memory_reduction_rate = (
            (total_memories_before - total_memories_after) / total_memories_before
            if total_memories_before > 0
            else 0
        )

        # Create comprehensive results
        results = {
            "analysis_metadata": {
                "total_cases_analyzed": total_cases,
                "analysis_timestamp": datetime.now().isoformat(),
                "llm_model_used": self.openai_model,
            },
            "processing_statistics": {
                "successful_processing_count": successful_processing,
                "processing_success_rate": processing_success_rate,
                "cases_with_improvement": improved_cases,
                "improvement_rate": improvement_rate,
                "original_answerable_cases": original_answerable,
                "original_answer_rate": original_answer_rate,
                "processed_answerable_cases": processed_answerable,
                "processed_answer_rate": processed_answer_rate,
                "answer_rate_improvement": processed_answer_rate - original_answer_rate,
            },
            "memory_statistics": {
                "total_memories_before_processing": total_memories_before,
                "total_memories_after_processing": total_memories_after,
                "memories_removed": total_memories_before - total_memories_after,
                "memory_reduction_rate": memory_reduction_rate,
                "average_memories_per_case_before": total_memories_before / total_cases
                if total_cases > 0
                else 0,
                "average_memories_per_case_after": total_memories_after / total_cases
                if total_cases > 0
                else 0,
            },
            "analyzed_cases": analyzed_cases,
        }

        # Log summary
        logger.info("LLM Processing Analysis Summary:")
        logger.info(f"  - Total cases: {total_cases}")
        logger.info(f"  - Processing success rate: {processing_success_rate:.2%}")
        logger.info(f"  - Cases with improvement: {improved_cases} ({improvement_rate:.2%})")
        logger.info(f"  - Original answer rate: {original_answer_rate:.2%}")
        logger.info(f"  - Processed answer rate: {processed_answer_rate:.2%}")
        logger.info(
            f"  - Answer rate improvement: {processed_answer_rate - original_answer_rate:.2%}"
        )
        logger.info(f"  - Memory reduction: {memory_reduction_rate:.2%}")

        # Save results if requested
        if save_results:
            if output_file is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_file = f"llm_processing_analysis_{timestamp}.json"

            try:
                with open(output_file, "w", encoding="utf-8") as f:
                    json.dump(results, f, indent=2, ensure_ascii=False)
                logger.info(f"Analysis results saved to: {output_file}")
            except Exception as e:
                logger.error(f"Failed to save results to {output_file}: {e}")

        return results


def main(version_name="ct-1111"):
    """Main test function."""
    print("=== EvalAnalyzer Simple Test ===")

    # Initialize analyzer
    analyzer = EvalAnalyzer(output_dir="./tmp/eval_analyzer")

    print("Analyzer initialized")

    # Test file paths
    eval_result_dir = f"{BASE_DIR}/evaluation/results/locomo/memos-api-{version_name}-locomo"
    judged_file = os.path.join(eval_result_dir, "memos-api_locomo_judged.json")
    search_results_file = os.path.join(eval_result_dir, "memos-api_locomo_search_results.json")

    print("Testing with files:")
    print(f"  Judged file: {judged_file}")
    print(f"  Search results file: {search_results_file}")

    # Check if files exist
    if not os.path.exists(judged_file):
        print(f"❌ Judged file not found: {judged_file}")
        return

    if not os.path.exists(search_results_file):
        print(f"❌ Search results file not found: {search_results_file}")
        return

    print("✅ Both files exist")

    # Test bad case extraction only
    try:
        print("\n=== Testing Bad Case Extraction ===")
        bad_cases = analyzer.extract_bad_cases(judged_file, search_results_file)

        print(f"✅ Successfully extracted {len(bad_cases)} bad cases")

        if bad_cases:
            print("\n=== Sample Bad Cases ===")
            for i, case in enumerate(bad_cases[:3]):  # Show first 3 cases
                print(f"\nBad Case {i + 1}:")
                print(f"  User ID: {case['user_id']}")
                print(f"  Query: {case['query'][:100]}...")
                print(f"  Golden Answer: {case['golden_answer']}...")
                print(f"  Answer: {case['answer']}...")
                print(f"  Has Memories: {len(case['memories']) > 0}")
                print(f"  Memory Length: {len(case['memories'])} chars")

        # Save basic results without LLM analysis
        basic_results = {
            "bad_cases_count": len(bad_cases),
            "bad_cases": bad_cases,
            "metadata": {
                "eval_result_dir": eval_result_dir,
                "judged_file": judged_file,
                "search_results_file": search_results_file,
                "extraction_only": True,
            },
        }

        output_file = analyzer.output_dir / "bad_cases_extraction_only.json"
        import json

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(basic_results, f, indent=2, ensure_ascii=False)

        print(f"\n✅ Basic extraction results saved to: {output_file}")

    except Exception as e:
        print(f"❌ Error during extraction: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    main()

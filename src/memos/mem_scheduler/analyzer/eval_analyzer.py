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

from memos.log import get_logger


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


def main(version_name="ct-1111"):
    """Main test function."""
    print("=== EvalAnalyzer Simple Test ===")

    # Initialize analyzer
    analyzer = EvalAnalyzer(output_dir="./tmp/eval_analyzer")

    print("Analyzer initialized")

    # Test file paths
    eval_result_dir = f"{BASE_DIR}/evaluation/results/locomo/memos-api-{version_name}"
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
    main(version_name="ct-1118")

import argparse
import asyncio
import json
import os
import sys

from pathlib import Path

from locomo_eval import LocomoEvaluator
from locomo_ingestion import LocomoIngestor
from locomo_metric import LocomoMetric
from locomo_processor import LocomoProcessor
from modules.locomo_eval_module import LocomoEvalModelModules
from modules.utils import compute_can_answer_stats

from memos.log import get_logger


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


class TemporalLocomoEval(LocomoEvalModelModules):
    def __init__(self, args):
        super().__init__(args=args)
        self.num_of_users = 10

        self.locomo_ingestor = LocomoIngestor(args=args)
        self.locomo_processor = LocomoProcessor(args=args)

    def run_eval_pipeline(self):
        """
        Run the complete evaluation pipeline including dataset conversion,
        data ingestion, and processing.
        """
        print("=" * 80)
        print("Starting TimeLocomo Evaluation Pipeline")
        print("=" * 80)

        # Step 1: Check if temporal_locomo dataset exists, if not convert it
        temporal_locomo_file = self.data_dir / "temporal_locomo" / "temporal_locomo_qa.json"
        if not temporal_locomo_file.exists():
            print(f"Temporal locomo dataset not found at {temporal_locomo_file}")
            print("Converting locomo dataset to temporal_locomo format...")
            self.convert_locomo_to_temporal_locomo(output_dir=self.data_dir / "temporal_locomo")
            print("Dataset conversion completed.")
        else:
            print(f"Temporal locomo dataset found at {temporal_locomo_file}, skipping conversion.")

        # Step 2: Data ingestion
        print("\n" + "=" * 50)
        print("Step 2: Data Ingestion")
        print("=" * 50)
        if not self.ingestion_storage_dir.exists() or not any(self.ingestion_storage_dir.iterdir()):
            print(f"Directory {self.ingestion_storage_dir} not found, starting data ingestion...")
            self.locomo_ingestor.run_ingestion()
            print("Data ingestion completed.")
        else:
            print(
                f"Directory {self.ingestion_storage_dir} already exists and is not empty, skipping ingestion."
            )

        # Step 3: Processing and evaluation
        print("\n" + "=" * 50)
        print("Step 3: Processing and Evaluation")
        print("=" * 50)
        print("Running locomo processing to search and answer...")

        print("Starting locomo processing to generate search and response results...")
        self.locomo_processor.run_locomo_processing(num_users=self.num_of_users)
        print("Processing completed successfully.")

        # Optional: run post-hoc evaluation over generated responses if available
        try:
            evaluator = LocomoEvaluator(args=args)

            if os.path.exists(evaluator.response_path):
                print("Running LocomoEvaluator over existing response results...")
                asyncio.run(evaluator.run())
            else:
                print(
                    f"Skipping LocomoEvaluator: response file not found at {evaluator.response_path}"
                )
            # Run metrics summarization if judged file is produced
            metric = LocomoMetric(args=args)
            if os.path.exists(metric.judged_path):
                print("Running LocomoMetric over judged results...")
                metric.run()
            else:
                print(f"Skipping LocomoMetric: judged file not found at {metric.judged_path}")
        except Exception as e:
            logger.error(f"LocomoEvaluator step skipped due to error: {e}", exc_info=True)

        # Step 4: Summary
        print("\n" + "=" * 80)
        print("Evaluation Pipeline Completed Successfully!")
        print("=" * 80)
        print("Results saved to:")
        print(f"  - Search results: {self.search_path}")
        print(f"  - Response results: {self.response_path}")
        print(f"  - Statistics: {self.stats_path}")
        print("=" * 80)

    def compute_can_answer_count_by_pre_evidences(self):
        """
        Compute can-answer statistics per day for each conversation using the
        union of all previously asked evidences within the same day.

        Returns:
            dict: Mapping conversation_id -> per-day stats as produced by compute_can_answer_stats
        """
        all_conversations_stats = {}
        for conv_idx in range(self.num_of_users):
            temporal_conv = self.temporal_locomo_data[conv_idx]
            conversation_id = temporal_conv["conversation_id"]

            # Build day -> qa_pairs mapping
            day_groups = {}
            for day_id, day_data in temporal_conv.get("days", {}).items():
                day_groups[day_id] = day_data.get("qa_pairs", [])

            # Use shared utility to compute stats with correct accumulation logic
            per_day_stats = compute_can_answer_stats(day_groups)
            all_conversations_stats[conversation_id] = per_day_stats
        # Build per-conversation summaries and overall summary
        per_conversation_summaries = {}
        overall_can = 0
        overall_total = 0
        for conv_id, day_stats in all_conversations_stats.items():
            conv_can = 0
            conv_total = 0
            for _day, stats in day_stats.items():
                conv_can += int(stats.get("can_answer_count", 0))
                conv_total += int(stats.get("total", 0))
            conv_ratio = (conv_can / conv_total) if conv_total else 0.0
            per_conversation_summaries[conv_id] = {
                "can_answer_count": conv_can,
                "total": conv_total,
                "ratio": conv_ratio,
            }
            overall_can += conv_can
            overall_total += conv_total

        overall_summary = {
            "can_answer_count": overall_can,
            "total": overall_total,
            "ratio": (overall_can / overall_total) if overall_total else 0.0,
        }

        result_payload = {
            "per_conversation_summary": per_conversation_summaries,
            "overall_summary": overall_summary,
        }

        # Print results
        print("\nComputed can-answer-by-pre-evidences stats:")
        print(json.dumps(result_payload, indent=2, ensure_ascii=False))

        # Save results
        output_path = self.stats_dir / "compute_can_answer_count_by_pre_evidences.json"
        with open(output_path, "w", encoding="utf-8") as fw:
            json.dump(result_payload, fw, indent=2, ensure_ascii=False)
        print(f"Saved stats to {output_path}")

        return result_payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--frame",
        type=str,
        default="memos_scheduler",
        choices=["zep", "memos", "mem0", "mem0_graph", "memos_scheduler"],
        help="Specify the memory framework (zep or memos or mem0 or mem0_graph)",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="v1.0.1",
        help="Version identifier for saving results (e.g., 1010)",
    )
    parser.add_argument(
        "--workers", type=int, default=1, help="Number of parallel workers to process users"
    )
    parser.add_argument(
        "--top_k", type=int, default=20, help="Number of results to retrieve in search queries"
    )
    parser.add_argument(
        "--scheduler-flag",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable or disable memory scheduler features",
    )
    args = parser.parse_args()

    evaluator = TemporalLocomoEval(args=args)
    evaluator.run_eval_pipeline()

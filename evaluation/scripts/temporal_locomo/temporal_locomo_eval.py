import argparse
import asyncio
import os
import sys

from pathlib import Path

from modules.locomo_eval_module import LocomoEvalModelModules
from modules.schemas import ContextUpdateMethod
from modules.utils import compute_can_answer_count_by_pre_evidences

from evaluation.scripts.temporal_locomo.models.locomo_eval import LocomoEvaluator
from evaluation.scripts.temporal_locomo.models.locomo_ingestion import LocomoIngestor
from evaluation.scripts.temporal_locomo.models.locomo_metric import LocomoMetric
from evaluation.scripts.temporal_locomo.models.locomo_processor import LocomoProcessor
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
        self.locomo_evaluator = LocomoEvaluator(args=args)
        self.locomo_metric = LocomoMetric(args=args)

    def run_answer_hit_eval_pipeline(self, skip_ingestion=True, skip_processing=False):
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
        if not skip_ingestion:
            print("\n" + "=" * 50)
            print("Step 2: Data Ingestion")
            print("=" * 50)
            self.locomo_ingestor.run_ingestion()

        # Step 3: Processing and evaluation
        if not skip_processing:
            print("\n" + "=" * 50)
            print("Step 3: Processing and Evaluation")
            print("=" * 50)
            print("Running locomo processing to search and answer...")

            print("Starting locomo processing to generate search and response results...")
            self.locomo_processor.run_locomo_processing(num_users=self.num_of_users)
            print("Processing completed successfully.")

        # Optional: run post-hoc evaluation over generated responses if available
        try:
            if os.path.exists(self.response_path):
                print("Running LocomoEvaluator over existing response results...")
                asyncio.run(self.locomo_evaluator.run())
            else:
                print(
                    f"Skipping LocomoEvaluator: response file not found at {evaluator.response_path}"
                )
            # Run metrics summarization if judged file is produced

            if os.path.exists(self.judged_path):
                print("Running LocomoMetric over judged results...")
                self.locomo_metric.run()
            else:
                print(f"Skipping LocomoMetric: judged file not found at {self.judged_path}")
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

    def compute_can_answer_count_by_pre_evidences(self, rounds_to_consider):
        """
        Compute can-answer statistics per day for each conversation using the
        union of all previously asked evidences within the same day.

        Returns:
            dict: Mapping conversation_id -> per-day stats as produced by compute_can_answer_stats
        """
        return compute_can_answer_count_by_pre_evidences(
            temporal_locomo_data=self.temporal_locomo_data,
            num_of_users=self.num_of_users,
            stats_dir=self.stats_dir,
            rounds_to_consider=rounds_to_consider,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--frame",
        type=str,
        default="memos",
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
        "--workers", type=int, default=10, help="Number of parallel workers to process users"
    )
    parser.add_argument(
        "--top_k", type=int, default=20, help="Number of results to retrieve in search queries"
    )
    parser.add_argument(
        "--scheduler_flag",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Enable or disable memory scheduler features",
    )
    parser.add_argument(
        "--context_update_method",
        type=str,
        default="chat_history",
        choices=ContextUpdateMethod.values(),
        help="Method to update context: pre_context (use previous context), chat_history (use template with history), current_context (use current context)",
    )
    args = parser.parse_args()

    evaluator = TemporalLocomoEval(args=args)
    evaluator.run_answer_hit_eval_pipeline()

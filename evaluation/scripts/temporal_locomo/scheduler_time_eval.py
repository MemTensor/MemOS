import argparse
import sys

from pathlib import Path

from modules.locomo_eval_module import LocomoEvalModelModules
from modules.schemas import ContextUpdateMethod

from evaluation.scripts.temporal_locomo.models.locomo_ingestion import LocomoIngestor
from evaluation.scripts.temporal_locomo.models.locomo_processor_w_time_eval import (
    LocomoProcessorWithTimeEval,
)
from memos.log import get_logger


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


# TODO: This evaluation has been suspended—it is not finished yet.
class TemporalLocomoForTimeEval(LocomoEvalModelModules):
    def __init__(self, args):
        args.result_dir_prefix = "time_eval-"

        super().__init__(args=args)
        self.num_of_users = 10

        self.locomo_ingestor = LocomoIngestor(args=args)
        self.locomo_processor = LocomoProcessorWithTimeEval(args=args)

    def run_time_eval_pipeline(self, skip_ingestion=True, skip_processing=False):
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
        print("\n" + "=" * 50)
        print("Step 3: Processing and Evaluation")
        print("=" * 50)
        print("Running locomo processing to search and answer...")

        print("Starting locomo processing to generate search and response results...")
        self.locomo_processor.run_locomo_processing(num_users=self.num_of_users)
        print("Processing completed successfully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
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

    args = parser.parse_args()

    args.frame = "memos_scheduler"
    args.scheduler_flag = True
    args.context_update_method = ContextUpdateMethod.PRE_CONTEXT

    evaluator = TemporalLocomoForTimeEval(args=args)
    evaluator.run_time_eval_pipeline()

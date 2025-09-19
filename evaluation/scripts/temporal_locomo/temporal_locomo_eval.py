import argparse
import sys

from pathlib import Path

from locomo_ingestion import LocomoIngestor
from locomo_processor import LocomoProcessor
from modules.locomo_eval_module import LocomoEvalModelModules

from memos.log import get_logger


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


class TimeLocomoEval(LocomoEvalModelModules):
    def __init__(self, args):
        super().__init__(args=args)

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
        self.locomo_processor.run_locomo_processing()
        print("Processing completed successfully.")

        # Step 4: Summary
        print("\n" + "=" * 80)
        print("Evaluation Pipeline Completed Successfully!")
        print("=" * 80)
        print("Results saved to:")
        print(f"  - Search results: {self.search_path}")
        print(f"  - Response results: {self.response_path}")
        print(f"  - Statistics: {self.stats_path}")
        print("=" * 80)


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
    args = parser.parse_args()

    evaluator = TimeLocomoEval(args=args)
    evaluator.run_eval_pipeline()

import logging

import requests

from memos.extras.nli_model.types import NLIResult


logger = logging.getLogger(__name__)


class NLIClient:
    """
    Client for interacting with the deployed NLI model service.
    """

    def __init__(self, base_url: str = "http://localhost:32532"):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()

    def compare_one_to_many(self, source: str, targets: list[str]) -> list[NLIResult]:
        """
        Compare one source text against multiple target memories using the NLI service.

        Args:
            source: The new memory content.
            targets: List of existing memory contents to compare against.

        Returns:
            List of NLIResult corresponding to each target.
        """
        if not targets:
            return []

        url = f"{self.base_url}/compare_one_to_many"
        # Match schemas.CompareRequest
        payload = {"source": source, "targets": targets}

        try:
            response = self.session.post(url, json=payload, timeout=30)
            response.raise_for_status()
            data = response.json()

            # Match schemas.CompareResponse
            results_str = data.get("results", [])

            results = []
            for res_str in results_str:
                try:
                    results.append(NLIResult(res_str))
                except ValueError:
                    logger.warning(
                        f"[NLIClient] Unknown result: {res_str}, defaulting to UNRELATED"
                    )
                    results.append(NLIResult.UNRELATED)

            return results

        except requests.RequestException as e:
            logger.error(f"[NLIClient] Request failed: {e}")
            # Fallback: if NLI fails, assume all are Unrelated to avoid blocking the flow.
            return [NLIResult.UNRELATED] * len(targets)

import logging
import time

import requests

from memos.extras.nli_model.types import NLIResult


logger = logging.getLogger(__name__)


class NLIClient:
    """
    Client for interacting with the deployed NLI model service.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:32532",
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff_seconds: float = 0.5,
    ):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_seconds = backoff_seconds

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

        last_error: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                response = self.session.post(url, json=payload, timeout=self.timeout)
                response.raise_for_status()
                data = response.json()

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
                last_error = e
                if attempt < self.max_retries:
                    logger.warning(
                        "[NLIClient] Request failed (attempt %s/%s) url=%s targets=%s error=%s",
                        attempt,
                        self.max_retries,
                        url,
                        len(targets),
                        e,
                    )
                    time.sleep(self.backoff_seconds * (2 ** (attempt - 1)))
                else:
                    logger.error(
                        "[NLIClient] Request failed after %s attempts url=%s targets=%s error=%s",
                        self.max_retries,
                        url,
                        len(targets),
                        e,
                    )

        logger.error(
            "[NLIClient] NLI service unavailable or unstable. Please check that it is running at %s",
            self.base_url,
        )
        if last_error:
            logger.error("[NLIClient] Last error: %s", last_error)
        return [NLIResult.UNRELATED] * len(targets)

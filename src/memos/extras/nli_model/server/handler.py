import re

from memos.extras.nli_model.server.config import NLI_MODEL_NAME, logger
from memos.extras.nli_model.types import NLIResult


# Placeholder for lazy imports
torch = None
AutoModelForSequenceClassification = None
AutoTokenizer = None


def _map_label_to_result(raw: str) -> NLIResult:
    t = raw.lower()
    if "entail" in t:
        return NLIResult.DUPLICATE
    if "contrad" in t or "refut" in t:
        return NLIResult.CONTRADICTION
    # Neutral or unknown
    return NLIResult.UNRELATED


def _clean_temporal_markers(s: str) -> str:
    # Remove temporal/aspect markers that might cause contradiction
    # Chinese markers (simple replace is usually okay as they are characters)
    zh_markers = ["刚刚", "曾经", "正在", "目前", "现在"]
    for m in zh_markers:
        s = s.replace(m, "")

    # English markers (need word boundaries to avoid "snow" -> "s")
    en_markers = ["just", "once", "currently", "now"]
    pattern = r"\b(" + "|".join(en_markers) + r")\b"
    s = re.sub(pattern, "", s, flags=re.IGNORECASE)

    # Cleanup extra spaces
    s = re.sub(r"\s+", " ", s).strip()
    return s


class NLIHandler:
    """
    NLI Model Handler for inference.
    Requires `torch` and `transformers` to be installed.
    """

    def __init__(self, device: str = "cpu", use_fp16: bool = True, use_compile: bool = True):
        global torch, AutoModelForSequenceClassification, AutoTokenizer
        try:
            import torch

            from transformers import AutoModelForSequenceClassification, AutoTokenizer
        except ImportError as e:
            raise ImportError(
                "NLIHandler requires 'torch' and 'transformers'. "
                "Please install them via 'pip install torch transformers' or use the requirements.txt."
            ) from e

        self.device = self._resolve_device(device)
        logger.info(f"Final resolved device: {self.device}")

        # Set defaults based on device if not explicitly provided
        is_cuda = "cuda" in self.device
        if not is_cuda:
            use_fp16 = False
            use_compile = False

        self.tokenizer = AutoTokenizer.from_pretrained(NLI_MODEL_NAME)

        model_kwargs = {}
        if use_fp16 and is_cuda:
            model_kwargs["torch_dtype"] = torch.float16

        self.model = AutoModelForSequenceClassification.from_pretrained(
            NLI_MODEL_NAME, **model_kwargs
        ).to(self.device)
        self.model.eval()

        self.id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        self.softmax = torch.nn.Softmax(dim=-1).to(self.device)

        if use_compile and hasattr(torch, "compile"):
            logger.info("Compiling model with torch.compile...")
            self.model = torch.compile(self.model)

    def _resolve_device(self, device: str) -> str:
        d = device.strip().lower()

        has_cuda = torch.cuda.is_available()
        has_mps = torch.backends.mps.is_available() if hasattr(torch.backends, "mps") else False

        if d == "cpu":
            return "cpu"

        if d.startswith("cuda"):
            if has_cuda:
                if d == "cuda":
                    return "cuda:0"
                return d

            # Fallback if CUDA not available
            if has_mps:
                logger.warning(
                    f"Device '{device}' requested but CUDA not available. Fallback to MPS."
                )
                return "mps"

            logger.warning(
                f"Device '{device}' requested but CUDA/MPS not available. Fallback to CPU."
            )
            return "cpu"

        if d == "mps":
            if has_mps:
                return "mps"

            logger.warning(f"Device '{device}' requested but MPS not available. Fallback to CPU.")
            return "cpu"

        # Fallback / Auto-detect for other cases (e.g. "gpu" or unknown)
        if has_cuda:
            return "cuda:0"
        if has_mps:
            return "mps"

        return "cpu"

    def predict_batch(self, premises: list[str], hypotheses: list[str]) -> list[NLIResult]:
        # Clean inputs
        premises = [_clean_temporal_markers(p) for p in premises]
        hypotheses = [_clean_temporal_markers(h) for h in hypotheses]

        # Batch tokenize with padding
        inputs = self.tokenizer(
            premises, hypotheses, return_tensors="pt", truncation=True, max_length=512, padding=True
        ).to(self.device)
        with torch.no_grad():
            out = self.model(**inputs)
            probs = self.softmax(out.logits)

        results = []
        for p in probs:
            idx = int(torch.argmax(p).item())
            res = self.id2label.get(idx, str(idx))
            results.append(_map_label_to_result(res))
        return results

    def compare_one_to_many(self, source: str, targets: list[str]) -> list[NLIResult]:
        """
        Compare one source text against multiple target memories efficiently using batch processing.
        Performs bidirectional checks (Source <-> Target) for each pair.
        """
        if not targets:
            return []

        n = len(targets)
        # Construct batch:
        # First n pairs: Source -> Target_i
        # Next n pairs: Target_i -> Source
        premises = [source] * n + targets
        hypotheses = targets + [source] * n

        # Run single large batch inference
        raw_results = self.predict_batch(premises, hypotheses)

        # Split results back
        results_ab = raw_results[:n]
        results_ba = raw_results[n:]

        final_results = []
        for i in range(n):
            res_ab = results_ab[i]
            res_ba = results_ba[i]

            # 1. Any Contradiction -> Contradiction (Sensitive detection, filtered by LLM later)
            if res_ab == NLIResult.CONTRADICTION or res_ba == NLIResult.CONTRADICTION:
                final_results.append(NLIResult.CONTRADICTION)

            # 2. Any Entailment -> Duplicate (as per user requirement)
            elif res_ab == NLIResult.DUPLICATE or res_ba == NLIResult.DUPLICATE:
                final_results.append(NLIResult.DUPLICATE)

            # 3. Otherwise (Both Neutral) -> Unrelated
            else:
                final_results.append(NLIResult.UNRELATED)

        return final_results

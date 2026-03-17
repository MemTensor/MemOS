import logging


NLI_MODEL_NAME = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"

# Configuration
# You can set the device directly here.
# Examples:
# - "cuda"         : Use default GPU (cuda:0) if available, else auto-fallback
# - "cuda:0"       : Use specific GPU
# - "mps"          : Use Apple Silicon GPU (if available)
# - "cpu"          : Use CPU
NLI_DEVICE = "cuda"
NLI_MODEL_HOST = "0.0.0.0"
NLI_MODEL_PORT = 32532

# Configure logging for NLI Server
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler("nli_server.log")],
)
logger = logging.getLogger("nli_server")

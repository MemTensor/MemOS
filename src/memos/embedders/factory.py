from typing import Any

from memos.embedders.factory import create_embedder as default_create_embedder
from memos.patches.universal_api import UniversalAPIEmbedder


def create_embedder(embedder_config: Any) -> Any:
    """
    Factory to create embedder instances, supporting UniversalAPIEmbedder.
    Intercepts 'universal_api' backend.
    """
    # handle both dict and object access for backend
    backend = getattr(embedder_config, "backend", None)
    if not backend and isinstance(embedder_config, dict):
        backend = embedder_config.get("backend")

    if backend == "universal_api":
        # Check if we need to convert dict to config object if UniversalAPIEmbedder expects it
        # Assuming UniversalAPIEmbedder handles the config structure passed from api_config
        # Note: memos.patches.universal_api imports UniversalAPIEmbedderConfig
        # We might need to wrap the dict config if the constructor expects an object

        # If embedder_config is a Pydantic model (likely), it has .config
        config = getattr(embedder_config, "config", None)
        if not config and isinstance(embedder_config, dict):
            config = embedder_config.get("config")

        # UniversalAPIEmbedder.__init__ probably expects a config object.
        # However, checking universal_api.py, it imports UniversalAPIEmbedderConfig.
        # We should try to use the raw config dict if possible or instantiate the config object.
        # But we don't have easy access to UniversalAPIEmbedderConfig unless we import it,
        # and we don't know if it accepts dict.

        # Let's inspect universal_api.py again.
        # UniversalAPIEmbedder takes `config: UniversalAPIEmbedderConfig`.
        # So we likely need to wrap it if it's a dict.

        from memos.configs.embedder import UniversalAPIEmbedderConfig

        if isinstance(config, dict):
            config = UniversalAPIEmbedderConfig(**config)

        return UniversalAPIEmbedder(config)

    return default_create_embedder(embedder_config)

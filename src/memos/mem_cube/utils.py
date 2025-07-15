import copy
import logging
import subprocess
import tempfile

from typing import Any

from memos.configs.mem_cube import GeneralMemCubeConfig


logger = logging.getLogger(__name__)


def download_repo(repo: str, base_url: str, dir: str | None = None) -> str:
    """Download a repository from a remote source.

    Args:
        repo (str): The repository name.
        base_url (str): The base URL of the remote repository.
        dir (str, optional): The directory where the repository will be downloaded. If None, a temporary directory will be created.
    If a directory is provided, it will be used instead of creating a temporary one.

    Returns:
        str: The local directory where the repository is downloaded.
    """
    if dir is None:
        dir = tempfile.mkdtemp()
    repo_url = f"{base_url}/{repo}"

    # Clone the repo
    subprocess.run(["git", "clone", repo_url, dir], check=True)

    return dir


def merge_config_with_default(
    existing_config: GeneralMemCubeConfig, default_config: GeneralMemCubeConfig
) -> GeneralMemCubeConfig:
    """
    Merge existing cube config with default config, preserving critical fields.

    This method updates general configuration fields (like API keys, model parameters)
    while preserving critical user-specific fields (like user_id, cube_id, graph_db settings).

    Args:
        existing_config (GeneralMemCubeConfig): The existing cube configuration loaded from file
        default_config (GeneralMemCubeConfig): The default configuration to merge from

    Returns:
        GeneralMemCubeConfig: Merged configuration
    """

    def deep_merge_dicts(
        existing: dict[str, Any], default: dict[str, Any], preserve_keys: set[str] | None = None
    ) -> dict[str, Any]:
        """Recursively merge dictionaries, preserving specified keys from existing dict."""
        if preserve_keys is None:
            preserve_keys = set()

        result = copy.deepcopy(existing)

        for key, default_value in default.items():
            if key in preserve_keys:
                # Preserve existing value for critical keys
                continue

            if key in result and isinstance(result[key], dict) and isinstance(default_value, dict):
                # Recursively merge nested dictionaries
                result[key] = deep_merge_dicts(result[key], default_value, preserve_keys)
            elif key not in result or result[key] is None:
                # Use default value if key doesn't exist or is None
                result[key] = copy.deepcopy(default_value)
            # For non-dict values, keep existing value unless it's None

        return result

    # Convert configs to dictionaries
    existing_dict = existing_config.model_dump(mode="json")
    default_dict = default_config.model_dump(mode="json")

    # Merge text_mem config
    if "text_mem" in existing_dict and "text_mem" in default_dict:
        existing_text_config = existing_dict["text_mem"].get("config", {})
        default_text_config = default_dict["text_mem"].get("config", {})

        # Handle nested graph_db config specially
        if "graph_db" in existing_text_config and "graph_db" in default_text_config:
            existing_graph_config = existing_text_config["graph_db"].get("config", {})
            default_graph_config = default_text_config["graph_db"].get("config", {})

            # Merge graph_db config, preserving critical keys
            merged_graph_config = deep_merge_dicts(
                existing_graph_config,
                default_graph_config,
                preserve_keys={"uri", "user", "password", "db_name", "auto_create"},
            )

            # Update the configs
            existing_text_config["graph_db"]["config"] = merged_graph_config
            default_text_config["graph_db"]["config"] = merged_graph_config

        # Merge other text_mem config fields
        merged_text_config = deep_merge_dicts(existing_text_config, default_text_config)
        existing_dict["text_mem"]["config"] = merged_text_config

    # Merge act_mem config
    if "act_mem" in existing_dict and "act_mem" in default_dict:
        existing_act_config = existing_dict["act_mem"].get("config", {})
        default_act_config = default_dict["act_mem"].get("config", {})
        merged_act_config = deep_merge_dicts(existing_act_config, default_act_config)
        existing_dict["act_mem"]["config"] = merged_act_config

    # Merge para_mem config
    if "para_mem" in existing_dict and "para_mem" in default_dict:
        existing_para_config = existing_dict["para_mem"].get("config", {})
        default_para_config = default_dict["para_mem"].get("config", {})
        merged_para_config = deep_merge_dicts(existing_para_config, default_para_config)
        existing_dict["para_mem"]["config"] = merged_para_config

    # Create new config from merged dictionary
    merged_config = GeneralMemCubeConfig.model_validate(existing_dict)
    logger.info(
        f"Merged cube config for user {merged_config.user_id}, cube {merged_config.cube_id}"
    )

    return merged_config

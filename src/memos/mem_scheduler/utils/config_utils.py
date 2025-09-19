import json
import os

from typing import Any

import yaml


def flatten_dict(
    data: dict[str, Any], parent_keys: list[str] | None = None, prefix: str = ""
) -> dict[str, str]:
    """
    Recursively flattens a nested dictionary to generate environment variable keys following the specified format.
    Combines nested keys with underscores, converts to uppercase, and prepends a custom prefix if provided.

    Args:
        data: Nested dictionary to be flattened (parsed from JSON/YAML)
        parent_keys: List to track nested keys during recursion
        prefix: Custom prefix to be added to all generated keys

    Returns:
        Flattened dictionary with keys in PREFIX_KEY1_KEY2... format and string values
    """
    parent_keys = parent_keys or []
    flat_data = {}

    for key, value in data.items():
        # Clean and standardize key: convert to uppercase, replace spaces/hyphens with underscores
        clean_key = key.upper().replace(" ", "_").replace("-", "_")
        current_keys = [*parent_keys, clean_key]

        if isinstance(value, dict):
            # Recursively process nested dictionaries
            nested_flat = flatten_dict(value, current_keys, prefix)
            flat_data.update(nested_flat)
        else:
            # Construct full key name with prefix (if provided) and nested keys
            if prefix:
                full_key = f"{prefix.upper()}_{'_'.join(current_keys)}"
            else:
                full_key = "_".join(current_keys)

            # Process value: ensure string type, convert None to empty string
            flat_value = "" if value is None else str(value).strip()

            flat_data[full_key] = flat_value

    return flat_data


def convert_config_to_env(input_file: str, output_file: str = ".env", prefix: str = "") -> None:
    """
    Converts a JSON or YAML configuration file to a .env file with standardized environment variables.
    Uses the flatten_dict function to generate keys in PREFIX_KEY1_KEY2... format.

    Args:
        input_file: Path to input configuration file (.json, .yaml, or .yml)
        output_file: Path to output .env file (default: .env)
        prefix: Custom prefix for all environment variable keys

    Raises:
        FileNotFoundError: If input file does not exist
        ValueError: If file format is unsupported or parsing fails
    """
    # Check if input file exists
    if not os.path.exists(input_file):
        raise FileNotFoundError(f"Input file not found: {input_file}")

    # Parse input file based on extension
    file_ext = os.path.splitext(input_file)[1].lower()
    config_data: dict[str, Any] = {}

    try:
        with open(input_file, encoding="utf-8") as f:
            if file_ext in (".json",):
                config_data = json.load(f)
            elif file_ext in (".yaml", ".yml"):
                config_data = yaml.safe_load(f)
            else:
                raise ValueError(
                    f"Unsupported file format: {file_ext}. Supported formats: .json, .yaml, .yml"
                )
    except (json.JSONDecodeError, yaml.YAMLError) as e:
        raise ValueError(f"Error parsing file: {e!s}") from e

    # Flatten configuration and generate environment variable key-value pairs
    flat_config = flatten_dict(config_data, prefix=prefix)

    # Write to .env file
    with open(output_file, "w", encoding="utf-8") as f:
        for key, value in flat_config.items():
            # Handle values containing double quotes (use no surrounding quotes)
            if '"' in value:
                f.write(f"{key}={value}\n")
            else:
                f.write(f'{key}="{value}"\n')  # Enclose regular values in double quotes

    print(
        f"Conversion complete! Generated {output_file} with {len(flat_config)} environment variables"
    )

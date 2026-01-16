import json

from pathlib import Path

from memos.api.server_api import app


OPENAPI_JSON_PATH = Path(__file__).parent.parent / "docs" / "openapi.json"


def test_openapi_json_up_to_date():
    """
    Ensure docs/openapi.json is up to date.
    If not, run: `make openapi` to regenerate it.
    """

    assert OPENAPI_JSON_PATH.exists(), (
        f"{OPENAPI_JSON_PATH} does not exist. Please run: `make openapi` to regenerate it."
    )

    # Get current OpenAPI schema and existing file
    current_openapi = app.openapi()
    with open(OPENAPI_JSON_PATH) as f:
        existing_openapi = json.load(f)

    # Remove dynamic values like UUIDs in defaults to avoid false positives
    def normalize(obj):
        if isinstance(obj, dict):
            return {k: normalize(v) for k, v in obj.items() if k != "default"}
        elif isinstance(obj, list):
            return [normalize(item) for item in obj]
        return obj

    # Compare normalized structures
    normalized_current = normalize(current_openapi)
    normalized_existing = normalize(existing_openapi)

    if normalized_current == normalized_existing:
        return  # Test passes

    # Generate helpful error message with specific differences
    def find_diffs(current, existing, path=""):
        diffs = []
        if type(current) is not type(existing):
            diffs.append(
                f"Type mismatch at {path}: {type(current).__name__} vs {type(existing).__name__}"
            )
        elif isinstance(current, dict):
            all_keys = set(current.keys()) | set(existing.keys())
            for key in sorted(all_keys):
                key_path = f"{path}.{key}" if path else key
                if key not in current:
                    diffs.append(f"Missing: {key_path}")
                elif key not in existing:
                    diffs.append(f"Added: {key_path}")
                else:
                    diffs.extend(find_diffs(current[key], existing[key], key_path))
        elif isinstance(current, list):
            if len(current) != len(existing):
                diffs.append(f"Array length differs at {path}: {len(current)} vs {len(existing)}")
            for i, (curr_item, exist_item) in enumerate(zip(current, existing, strict=False)):
                diffs.extend(find_diffs(curr_item, exist_item, f"{path}[{i}]"))
        elif current != existing:
            diffs.append(f"Value differs at {path}")
        return diffs

    differences = find_diffs(normalized_current, normalized_existing)

    # Format error message
    max_diffs = 5
    diff_preview = "\n".join(f"  - {diff}" for diff in differences[:max_diffs])
    if len(differences) > max_diffs:
        diff_preview += f"\n  ... and {len(differences) - max_diffs} more"

    raise AssertionError(
        f"OpenAPI schema is out of date ({len(differences)} differences found):\n"
        f"{diff_preview}\n\n"
        f"To fix, run: `make openapi` to regenerate it."
    )

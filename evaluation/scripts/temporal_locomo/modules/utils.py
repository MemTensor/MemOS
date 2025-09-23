import json

from pathlib import Path

from .schemas import RecordingCase


def filter_memory_data(memories_data):
    filtered_data = {}
    for key, value in memories_data.items():
        if key == "text_mem":
            filtered_data[key] = []
            for mem_group in value:
                # Check if it's the new data structure (list of TextualMemoryItem objects)
                if "memories" in mem_group and isinstance(mem_group["memories"], list):
                    # New data structure: directly a list of TextualMemoryItem objects
                    filtered_memories = []
                    for memory_item in mem_group["memories"]:
                        # Create filtered dictionary
                        filtered_item = {
                            "id": memory_item.id,
                            "memory": memory_item.memory,
                            "metadata": {},
                        }
                        # Filter metadata, excluding embedding
                        if hasattr(memory_item, "metadata") and memory_item.metadata:
                            for attr_name in dir(memory_item.metadata):
                                if not attr_name.startswith("_") and attr_name != "embedding":
                                    attr_value = getattr(memory_item.metadata, attr_name)
                                    if not callable(attr_value):
                                        filtered_item["metadata"][attr_name] = attr_value
                        filtered_memories.append(filtered_item)

                    filtered_group = {
                        "cube_id": mem_group.get("cube_id", ""),
                        "memories": filtered_memories,
                    }
                    filtered_data[key].append(filtered_group)
                else:
                    # Old data structure: dictionary with nodes and edges
                    filtered_group = {
                        "memories": {"nodes": [], "edges": mem_group["memories"].get("edges", [])}
                    }
                    for node in mem_group["memories"].get("nodes", []):
                        filtered_node = {
                            "id": node.get("id"),
                            "memory": node.get("memory"),
                            "metadata": {
                                k: v
                                for k, v in node.get("metadata", {}).items()
                                if k != "embedding"
                            },
                        }
                        filtered_group["memories"]["nodes"].append(filtered_node)
                    filtered_data[key].append(filtered_group)
        else:
            filtered_data[key] = value
    return filtered_data


def save_recording_cases(
    cases: list[RecordingCase], output_dir: str | Path, filename: str = "recording_cases.json"
) -> Path:
    """
    Save a list of RecordingCase objects to a JSON file.

    Args:
        cases: List of RecordingCase objects to save
        output_dir: Directory to save the file
        filename: Name of the output file (default: "recording_cases.json")

    Returns:
        Path: Path to the saved file
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    file_path = output_dir / filename

    # Convert cases to dictionaries for JSON serialization
    cases_data = [case.to_dict() for case in cases]

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(cases_data, f, indent=2, ensure_ascii=False)

    return file_path


def load_recording_cases(file_path: str | Path) -> list[RecordingCase]:
    """
    Load RecordingCase objects from a JSON file.

    Args:
        file_path: Path to the JSON file containing RecordingCase data

    Returns:
        List[RecordingCase]: List of RecordingCase objects loaded from the file
    """
    file_path = Path(file_path)

    with open(file_path, encoding="utf-8") as f:
        cases_data = json.load(f)

    return [RecordingCase.from_dict(case_data) for case_data in cases_data]


def save_evaluation_cases(
    can_answer_cases: list[RecordingCase],
    cannot_answer_cases: list[RecordingCase],
    output_dir: str | Path,
    frame: str = "default",
    version: str = "default",
) -> dict[str, Path]:
    """
    Save both can_answer_cases and cannot_answer_cases to separate JSON files.

    Args:
        can_answer_cases: List of cases that can be answered
        cannot_answer_cases: List of cases that cannot be answered
        output_dir: Directory to save the files
        frame: Framework name for filename prefix
        version: Version identifier for filename

    Returns:
        Dict[str, Path]: Dictionary mapping case type to saved file path
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    saved_files = {}

    # Save can_answer_cases
    if can_answer_cases:
        can_answer_filename = f"{frame}_{version}_can_answer_cases.json"
        can_answer_path = save_recording_cases(can_answer_cases, output_dir, can_answer_filename)
        saved_files["can_answer_cases"] = can_answer_path
        print(f"Saved {len(can_answer_cases)} can_answer_cases to {can_answer_path}")

    # Save cannot_answer_cases
    if cannot_answer_cases:
        cannot_answer_filename = f"{frame}_{version}_cannot_answer_cases.json"
        cannot_answer_path = save_recording_cases(
            cannot_answer_cases, output_dir, cannot_answer_filename
        )
        saved_files["cannot_answer_cases"] = cannot_answer_path
        print(f"Saved {len(cannot_answer_cases)} cannot_answer_cases to {cannot_answer_path}")

    return saved_files


def extract_day_evidences(evidence_list, day):
    """
    Extract evidences that belong to the given day.

    Evidence items are expected to be strings in the form "D#:pos", e.g., "D1:3".

    Args:
        evidence_list: List of evidence strings
        day: Day identifier string such as "D1"

    Returns:
        set[str]: Set of evidence strings that start with the given day prefix
    """
    day_prefix = f"{day}:"
    return {e for e in evidence_list if isinstance(e, str) and e.startswith(day_prefix)}


def compute_can_answer_stats(day_groups):
    """
    Compute can-answer statistics for each day using the union of all prior evidences.

    For each day, iterate over the QAs in the given order. If the current QA's
    evidences (restricted to the same day) are a subset of the union of all
    previously seen evidences for that day, increment can_answer_count. Then add
    the current evidences to the seen set.

    Note:
        The first QA of each day is excluded from the statistics because it
        cannot be answered without any prior evidences. It is still used to
        seed the seen evidences for subsequent QAs.

    Args:
        day_groups: Dict mapping day_id (e.g., "D1") to a list of QA dicts. Each QA
                    dict should contain an "evidence" field that is a list of strings.

    Returns:
        dict: Mapping day_id -> {"can_answer_count": int, "total": int, "ratio": float}
    """
    results = {}
    for day, qa_list in day_groups.items():
        seen = set()
        can_answer = 0
        total = max(len(qa_list) - 1, 0)
        for idx, qa in enumerate(qa_list):
            cur = extract_day_evidences(qa.get("evidence", []), day)
            if idx == 0:
                # Seed seen evidences with the first QA but do not count it
                seen |= cur
                continue
            if cur and cur.issubset(seen):
                can_answer += 1
            # Accumulate all previously asked evidences (union)
            seen |= cur
        results[day] = {
            "can_answer_count": can_answer,
            "total": total,
            "ratio": (can_answer / total) if total else 0.0,
        }
    return results

import re
import shutil
import tempfile
import zipfile

from pathlib import Path
from typing import Any
from uuid import uuid4

import requests

from memos.embedders.base import BaseEmbedder
from memos.log import get_logger
from memos.mem_reader.read_skill_memory.process_skill_memory import (
    create_skill_memory_item,
)
from memos.memories.textual.item import TextualMemoryItem
from memos.utils import timed


logger = get_logger(__name__)

_TEXT_MAX_LEN = 20


def _truncate(text: str) -> str:
    """Truncate a string to at most ``_TEXT_MAX_LEN`` characters."""
    return text[:_TEXT_MAX_LEN]


def _extract_zip_url_from_items(items: list[TextualMemoryItem]) -> str | None:
    """
    Extract the zip download URL from fast-stage memory items.

    FileContentParser.parse_fast stores the URL in source.file_info["file_data"].
    Each upload-skill request contains exactly one zip URL.
    """
    for item in items:
        for source in getattr(item.metadata, "sources", None) or []:
            file_info = getattr(source, "file_info", None)
            if not isinstance(file_info, dict):
                continue
            file_data = file_info.get("file_data", "")
            if (
                isinstance(file_data, str)
                and file_data.startswith(("http://", "https://"))
                and file_data.lower().endswith(".zip")
            ):
                return file_data
    return None


def _download_zip(url: str, tmp_dir: Path) -> Path:
    """Download a zip file to a local temporary directory."""
    try:
        resp = requests.get(url, stream=True, timeout=60)
        resp.raise_for_status()
    except Exception as e:
        raise ValueError(f"Failed to download zip from {url}: {e}") from e

    zip_path = tmp_dir / f"{uuid4()}.zip"
    with open(zip_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)

    if not zipfile.is_zipfile(zip_path):
        raise ValueError(f"Downloaded file is not a valid zip: {url}")

    return zip_path


def _extract_and_parse_skill_zip(zip_path: Path) -> dict[str, Any]:
    """
    Extract a skill zip and parse SKILL.md + directory contents into a skill_memory dict.

    The SKILL.md format mirrors the output of ``_write_skills_to_file`` in
    ``process_skill_memory.py``.  Section headings at any level (``#`` through
    ``######``) are matched by title text (case-insensitive).
    """
    # Step 1: extract & locate SKILL.md
    extract_dir = zip_path.parent / zip_path.stem
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(extract_dir)

    skill_md_path = None
    for candidate in extract_dir.rglob("SKILL.md"):
        skill_md_path = candidate
        break

    if skill_md_path is None:
        raise FileNotFoundError(f"SKILL.md not found in zip: {zip_path.name}")

    skill_root = skill_md_path.parent
    raw_text = skill_md_path.read_text(encoding="utf-8")

    # Step 2: parse frontmatter → name, description
    name = ""
    description = ""
    fm_match = re.match(r"^---\s*\n(.*?)\n---", raw_text, re.DOTALL)
    if fm_match:
        for line in fm_match.group(1).splitlines():
            if line.startswith("name:"):
                name = line[len("name:") :].strip()
            elif line.startswith("description:"):
                description = line[len("description:") :].strip()

    if not name:
        name = zip_path.stem

    # Step 3: split body by any-level heading and parse each section
    trigger: str = ""
    procedure: str = ""
    experience: list[str] = []
    preference: list[str] = []
    examples: list[str] = []
    tool: str | None = None
    others_inline: dict[str, str] = {}

    known_sections = {
        "trigger",
        "procedure",
        "experience",
        "user preferences",
        "examples",
        "scripts",
        "tool usage",
        "additional information",
    }

    body = raw_text[fm_match.end() :] if fm_match else raw_text
    sections = re.split(r"\n(?=#{1,6}\s)", body)

    for section in sections:
        section = section.strip()
        if not section:
            continue

        heading_match = re.match(r"^(#{1,6})\s+(.*)", section)
        if not heading_match:
            continue

        title = heading_match.group(2).strip()
        content = section[heading_match.end() :].strip()
        title_lower = title.lower()

        if title_lower not in known_sections:
            logger.warning("[UPLOAD_SKILL] Unknown section '%s' in SKILL.md, skipping", title)
            continue

        if title_lower == "trigger":
            trigger = content

        elif title_lower == "procedure":
            procedure = content

        elif title_lower == "experience":
            items = re.findall(r"^\d+\.\s+(.+)$", content, re.MULTILINE)
            experience = [item.strip() for item in items] if items else []

        elif title_lower == "user preferences":
            items = re.findall(r"^-\s+(.+)$", content, re.MULTILINE)
            preference = [item.strip() for item in items] if items else []

        elif title_lower == "examples":
            blocks = re.findall(r"```markdown\n(.*?)\n```", content, re.DOTALL)
            examples = [b.strip() for b in blocks]

        elif title_lower == "scripts":
            pass

        elif title_lower == "tool usage":
            tool = content.strip() if content.strip() else None

        elif title_lower == "additional information":
            sub_sections = re.split(r"\n(?=#{1,6}\s)", content)
            for sub in sub_sections:
                sub = sub.strip()
                if not sub or sub.startswith("See also:"):
                    continue
                sub_heading = re.match(r"^(#{1,6})\s+(.*)", sub)
                if not sub_heading:
                    continue
                sub_key = sub_heading.group(2).strip()
                sub_val = sub[sub_heading.end() :].strip()
                if sub_val:
                    others_inline[sub_key] = sub_val

    # Step 4: read scripts/ directory
    scripts: dict[str, str] | None = None
    scripts_dir = skill_root / "scripts"
    if scripts_dir.is_dir():
        scripts = {}
        for py_file in scripts_dir.glob("*.py"):
            scripts[py_file.name] = py_file.read_text(encoding="utf-8")

    # Step 5: read reference/ directory → merge into others
    others = dict(others_inline)
    reference_dir = skill_root / "reference"
    if reference_dir.is_dir():
        for md_file in reference_dir.glob("*.md"):
            others[md_file.name] = md_file.read_text(encoding="utf-8")

    # Step 6: truncate text fields & assemble return dict
    truncated_trigger = _truncate(trigger)

    result: dict[str, Any] = {
        "name": name,
        "description": description,
        "tags": [truncated_trigger] if truncated_trigger else [],
        "procedure": _truncate(procedure),
        "experience": [_truncate(e) for e in experience],
        "preference": [_truncate(p) for p in preference],
        "examples": [_truncate(e) for e in examples],
        "tool": _truncate(tool) if tool else None,
        "scripts": {k: _truncate(v) for k, v in scripts.items()} if scripts else None,
        "others": {k: _truncate(v) for k, v in others.items()} if others else None,
    }
    # Only include trigger when non-empty; create_skill_memory_item uses
    # `skill_memory.get("tags") or skill_memory.get("trigger", [])`,
    # an empty-string trigger would override the correct [] fallback.
    if truncated_trigger:
        result["trigger"] = truncated_trigger
    return result


@timed
def process_upload_skill_memory(
    fast_memory_items: list[TextualMemoryItem],
    info: dict[str, Any],
    embedder: BaseEmbedder | None = None,
    oss_config: dict[str, Any] | None = None,
    skills_dir_config: dict[str, Any] | None = None,
    **kwargs,
) -> list[TextualMemoryItem]:
    """
    Process a user-uploaded skill zip, parse it, and build a SkillMemory node.

    The zip URL is taken from the fast-stage ``TextualMemoryItem`` sources
    (``source.file_info["file_data"]``), consistent with both sync-fine and
    async-transfer paths.
    """
    zip_url = _extract_zip_url_from_items(fast_memory_items)
    if not zip_url:
        logger.warning("[UPLOAD_SKILL] No zip URL found in fast_memory_items")
        return []

    tmp_dir = Path(tempfile.mkdtemp(prefix="upload_skill_"))
    try:
        zip_path = _download_zip(zip_url, tmp_dir)
    except Exception as e:
        logger.warning("[UPLOAD_SKILL] Failed to download zip: %s", e)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return []

    try:
        skill_memory = _extract_and_parse_skill_zip(zip_path)
    except FileNotFoundError as e:
        logger.warning("[UPLOAD_SKILL] %s", e)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return []
    except Exception as e:
        logger.error("[UPLOAD_SKILL] Failed to parse skill zip: %s", e)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return []

    skill_memory["url"] = zip_url
    skill_memory["skill_source"] = "user_upload"

    try:
        skill_memory_item = create_skill_memory_item(skill_memory, info, embedder, **kwargs)
    except Exception as e:
        logger.error("[UPLOAD_SKILL] Failed to create skill memory item: %s", e)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return []

    # Cleanup temp files
    shutil.rmtree(tmp_dir, ignore_errors=True)

    logger.info(
        "[UPLOAD_SKILL] Successfully created SkillMemory from uploaded zip: name=%s, id=%s",
        skill_memory.get("name"),
        skill_memory_item.id,
    )
    return [skill_memory_item]

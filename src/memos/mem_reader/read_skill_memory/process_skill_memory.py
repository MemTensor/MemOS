import json
import os
import tempfile
import uuid
import zipfile

from concurrent.futures import as_completed
from datetime import datetime
from typing import Any

import alibabacloud_oss_v2 as oss

from memos.context.context import ContextThreadPoolExecutor
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.templates.skill_mem_prompt import (
    SKILL_MEMORY_EXTRACTION_PROMPT,
    TASK_CHUNKING_PROMPT,
    TASK_QUERY_REWRITE_PROMPT,
)
from memos.types import MessageList


logger = get_logger(__name__)


OSS_DIR = "memos/skill_memory/"


def create_oss_client() -> oss.Client:
    credentials_provider = oss.credentials.EnvironmentVariableCredentialsProvider()

    # load SDK's default configuration, and set credential provider
    cfg = oss.config.load_default()
    cfg.credentials_provider = credentials_provider
    cfg.region = os.getenv("OSS_REGION")
    cfg.endpoint = os.getenv("OSS_ENDPOINT")
    client = oss.Client(cfg)

    return client


OSS_CLIENT = create_oss_client()


def _reconstruct_messages_from_memory_items(memory_items: list[TextualMemoryItem]) -> MessageList:
    reconstructed_messages = []
    for memory_item in memory_items:
        for source_message in memory_item.metadata.sources:
            try:
                role = source_message.role
                content = source_message.content
                reconstructed_messages.append({"role": role, "content": content})
            except Exception as e:
                logger.error(f"Error reconstructing message: {e}")
                continue
    return reconstructed_messages


def _add_index_to_message(messages: MessageList) -> MessageList:
    for i, message in enumerate(messages):
        message["idx"] = i
    return messages


def _split_task_chunk_by_llm(llm: BaseLLM, messages: MessageList) -> dict[str, MessageList]:
    """Split messages into task chunks by LLM."""
    messages_context = "\n".join(
        [
            f"{message.get('idx', i)}: {message['role']}: {message['content']}"
            for i, message in enumerate(messages)
        ]
    )
    prompt = [
        {"role": "user", "content": TASK_CHUNKING_PROMPT.replace("{{messages}}", messages_context)}
    ]
    for attempt in range(3):
        try:
            response_text = llm.generate(prompt)
            break
        except Exception as e:
            logger.warning(f"LLM generate failed (attempt {attempt + 1}): {e}")
            if attempt == 2:
                logger.error("LLM generate failed after 3 retries, returning default value")
                return {"default": [messages[i] for i in range(len(messages))]}
    response_json = json.loads(response_text.replace("```json", "").replace("```", ""))
    task_chunks = {}
    for item in response_json:
        task_name = item["task_name"]
        message_indices = item["message_indices"]
        for start, end in message_indices:
            task_chunks.setdefault(task_name, []).extend(messages[start : end + 1])
    return task_chunks


def _extract_skill_memory_by_llm(
    messages: MessageList, old_memories: list[TextualMemoryItem], llm: BaseLLM
) -> dict[str, Any]:
    old_memories_dict = [skill_memory.model_dump() for skill_memory in old_memories]
    old_mem_references = [
        {
            "id": mem["id"],
            "name": mem["metadata"]["name"],
            "description": mem["metadata"]["description"],
            "procedure": mem["metadata"]["procedure"],
            "experience": mem["metadata"]["experience"],
            "preference": mem["metadata"]["preference"],
            "example": mem["metadata"]["example"],
            "tags": mem["metadata"]["tags"],
            "scripts": mem["metadata"].get("scripts"),
            "others": mem["metadata"]["others"],
        }
        for mem in old_memories_dict
    ]

    # Prepare conversation context
    messages_context = "\n".join(
        [f"{message['role']}: {message['content']}" for message in messages]
    )

    # Prepare old memories context
    old_memories_context = json.dumps(old_mem_references, ensure_ascii=False, indent=2)

    # Prepare prompt
    prompt_content = SKILL_MEMORY_EXTRACTION_PROMPT.replace(
        "{old_memories}", old_memories_context
    ).replace("{messages}", messages_context)

    prompt = [{"role": "user", "content": prompt_content}]

    # Call LLM to extract skill memory with retry logic
    for attempt in range(3):
        try:
            response_text = llm.generate(prompt)
            # Clean up response (remove markdown code blocks if present)
            response_text = response_text.strip()
            if response_text.startswith("```json"):
                response_text = response_text.replace("```json", "").replace("```", "").strip()
            elif response_text.startswith("```"):
                response_text = response_text.replace("```", "").strip()

            # Parse JSON response
            skill_memory = json.loads(response_text)

            # Validate response
            if skill_memory is None:
                logger.info("No skill memory extracted from conversation")
                return None

            return skill_memory

        except json.JSONDecodeError as e:
            logger.warning(f"JSON decode failed (attempt {attempt + 1}): {e}")
            logger.debug(f"Response text: {response_text}")
            if attempt == 2:
                logger.error("Failed to parse skill memory after 3 retries")
                return None
        except Exception as e:
            logger.warning(f"LLM skill memory extraction failed (attempt {attempt + 1}): {e}")
            if attempt == 2:
                logger.error("LLM skill memory extraction failed after 3 retries")
                return None

    return None


def _recall_related_skill_memories(
    task_type: str,
    messages: MessageList,
    searcher: Searcher,
    llm: BaseLLM,
    rewrite_query: bool,
) -> list[TextualMemoryItem]:
    query = _rewrite_query(task_type, messages, llm, rewrite_query)
    related_skill_memories = searcher.search(query, top_k=10, memory_type="SkillMemory")

    return related_skill_memories


def _rewrite_query(task_type: str, messages: MessageList, llm: BaseLLM, rewrite_query: bool) -> str:
    if not rewrite_query:
        # Return the first user message content if rewrite is disabled
        return messages[0]["content"] if messages else ""

    # Construct messages context for LLM
    messages_context = "\n".join(
        [f"{message['role']}: {message['content']}" for message in messages]
    )

    # Prepare prompt with task type and messages
    prompt_content = TASK_QUERY_REWRITE_PROMPT.replace("{task_type}", task_type).replace(
        "{messages}", messages_context
    )
    prompt = [{"role": "user", "content": prompt_content}]

    # Call LLM to rewrite the query with retry logic
    for attempt in range(3):
        try:
            response_text = llm.generate(prompt)
            # Clean up response (remove any markdown formatting if present)
            response_text = response_text.strip()
            logger.info(f"Rewritten query for task '{task_type}': {response_text}")
            return response_text
        except Exception as e:
            logger.warning(f"LLM query rewrite failed (attempt {attempt + 1}): {e}")
            if attempt == 2:
                logger.error(
                    "LLM query rewrite failed after 3 retries, returning first message content"
                )
                return messages[0]["content"] if messages else ""

    # Fallback (should not reach here due to return in exception handling)
    return messages[0]["content"] if messages else ""


def _upload_skills_to_oss(local_file_path: str, oss_file_path: str, client: oss.Client) -> str:
    client.put_object_from_file(
        request=oss.PutObjectRequest(
            bucket=os.getenv("OSS_BUCKET_NAME"),
            key=oss_file_path,
        ),
        filepath=local_file_path,
    )

    # Construct and return the URL
    bucket_name = os.getenv("OSS_BUCKET_NAME")
    endpoint = os.getenv("OSS_ENDPOINT")
    url = f"https://{bucket_name}.{endpoint}/{oss_file_path}"
    return url


def _delete_skills_from_oss(oss_file_path: str, client: oss.Client) -> oss.DeleteObjectResult:
    result = client.delete_object(
        oss.DeleteObjectRequest(
            bucket=os.getenv("OSS_BUCKET_NAME"),
            key=oss_file_path,
        )
    )
    return result


def _write_skills_to_file(skill_memory: dict[str, Any], info: dict[str, Any]) -> str:
    user_id = info.get("user_id", "unknown")
    skill_name = skill_memory.get("name", "unnamed_skill").replace(" ", "_").lower()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Create tmp directory for user if it doesn't exist
    tmp_dir = os.path.join("/tmp", user_id)
    os.makedirs(tmp_dir, exist_ok=True)

    # Create a temporary directory for the skill structure
    with tempfile.TemporaryDirectory() as temp_skill_dir:
        skill_dir = os.path.join(temp_skill_dir, skill_name)
        os.makedirs(skill_dir, exist_ok=True)

        # Generate SKILL.md content with frontmatter
        skill_md_content = f"""---
name: {skill_name}
description: {skill_memory.get("description", "")}
tags: {", ".join(skill_memory.get("tags", []))}
---
"""

        # Add Procedure section only if present
        procedure = skill_memory.get("procedure", "")
        if procedure and procedure.strip():
            skill_md_content += f"\n## Procedure\n{procedure}\n"

        # Add Experience section only if there are items
        experiences = skill_memory.get("experience", [])
        if experiences:
            skill_md_content += "\n## Experience\n"
            for idx, exp in enumerate(experiences, 1):
                skill_md_content += f"{idx}. {exp}\n"

        # Add User Preferences section only if there are items
        preferences = skill_memory.get("preference", [])
        if preferences:
            skill_md_content += "\n## User Preferences\n"
            for pref in preferences:
                skill_md_content += f"- {pref}\n"

        # Add Examples section only if there are items
        examples = skill_memory.get("example", [])
        if examples:
            skill_md_content += "\n## Examples\n"
            for idx, example in enumerate(examples, 1):
                skill_md_content += f"\n### Example {idx}\n{example}\n"

        # Add scripts reference if present
        scripts = skill_memory.get("scripts")
        if scripts and isinstance(scripts, dict):
            skill_md_content += "\n## Scripts\n"
            skill_md_content += "This skill includes the following executable scripts:\n\n"
            for script_name in scripts:
                skill_md_content += f"- `./scripts/{script_name}`\n"

        # Add others - handle both inline content and separate markdown files
        others = skill_memory.get("others")
        if others and isinstance(others, dict):
            # Separate markdown files from inline content
            md_files = {}
            inline_content = {}

            for key, value in others.items():
                if key.endswith(".md"):
                    md_files[key] = value
                else:
                    inline_content[key] = value

            # Add inline content to SKILL.md
            if inline_content:
                skill_md_content += "\n## Additional Information\n"
                for key, value in inline_content.items():
                    skill_md_content += f"\n### {key}\n{value}\n"

            # Add references to separate markdown files
            if md_files:
                if not inline_content:
                    skill_md_content += "\n## Additional Information\n"
                skill_md_content += "\nSee also:\n"
                for md_filename in md_files:
                    skill_md_content += f"- [{md_filename}](./{md_filename})\n"

        # Write SKILL.md file
        skill_md_path = os.path.join(skill_dir, "SKILL.md")
        with open(skill_md_path, "w", encoding="utf-8") as f:
            f.write(skill_md_content)

        # Write separate markdown files from others
        if others and isinstance(others, dict):
            for key, value in others.items():
                if key.endswith(".md"):
                    md_file_path = os.path.join(skill_dir, key)
                    with open(md_file_path, "w", encoding="utf-8") as f:
                        f.write(value)

        # If there are scripts, create a scripts directory with individual script files
        if scripts and isinstance(scripts, dict):
            scripts_dir = os.path.join(skill_dir, "scripts")
            os.makedirs(scripts_dir, exist_ok=True)

            # Write each script to its own file
            for script_filename, script_content in scripts.items():
                # Ensure filename ends with .py
                if not script_filename.endswith(".py"):
                    script_filename = f"{script_filename}.py"

                script_path = os.path.join(scripts_dir, script_filename)
                with open(script_path, "w", encoding="utf-8") as f:
                    f.write(script_content)

        # Create zip file
        zip_filename = f"{skill_name}_{timestamp}.zip"
        zip_path = os.path.join(tmp_dir, zip_filename)

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            # Walk through the skill directory and add all files
            for root, _dirs, files in os.walk(skill_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_skill_dir)
                    zipf.write(file_path, arcname)

        logger.info(f"Created skill zip file: {zip_path}")
        return zip_path


def create_skill_memory_item(
    skill_memory: dict[str, Any], info: dict[str, Any], zip_path: str
) -> TextualMemoryItem:
    info_ = info.copy()
    user_id = info_.pop("user_id", "")
    session_id = info_.pop("session_id", "")

    # Use description as the memory content
    memory_content = skill_memory.get("description", "")

    # Create metadata with all skill-specific fields directly
    metadata = TreeNodeTextualMemoryMetadata(
        user_id=user_id,
        session_id=session_id,
        memory_type="SkillMemory",
        status="activated",
        tags=skill_memory.get("tags", []),
        key=skill_memory.get("name", ""),
        sources=[],
        usage=[],
        background="",
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
        info=info_,
        # Skill-specific fields
        name=skill_memory.get("name", ""),
        description=skill_memory.get("description", ""),
        procedure=skill_memory.get("procedure", ""),
        experience=skill_memory.get("experience", []),
        preference=skill_memory.get("preference", []),
        example=skill_memory.get("example", []),
        scripts=skill_memory.get("scripts"),
        others=skill_memory.get("others"),
        url=skill_memory.get("url", ""),
    )

    # If this is an update, use the old memory ID
    item_id = (
        skill_memory.get("old_memory_id", "")
        if skill_memory.get("update", False)
        else str(uuid.uuid4())
    )
    if not item_id:
        item_id = str(uuid.uuid4())

    return TextualMemoryItem(id=item_id, memory=memory_content, metadata=metadata)


def process_skill_memory_fine(
    fast_memory_items: list[TextualMemoryItem],
    info: dict[str, Any],
    searcher: Searcher | None = None,
    llm: BaseLLM | None = None,
    rewrite_query: bool = False,
    **kwargs,
) -> list[TextualMemoryItem]:
    messages = _reconstruct_messages_from_memory_items(fast_memory_items)
    messages = _add_index_to_message(messages)

    task_chunks = _split_task_chunk_by_llm(llm, messages)

    # recall
    related_skill_memories = []
    for task, msg in task_chunks.items():
        related_skill_memories.extend(
            _recall_related_skill_memories(
                task_type=task,
                messages=msg,
                searcher=searcher,
                llm=llm,
                rewrite_query=rewrite_query,
            )
        )

    skill_memories = []
    with ContextThreadPoolExecutor(max_workers=min(len(task_chunks), 5)) as executor:
        futures = {
            executor.submit(
                _extract_skill_memory_by_llm, messages, related_skill_memories, llm
            ): task_type
            for task_type, messages in task_chunks.items()
        }
        for future in as_completed(futures):
            try:
                skill_memory = future.result()
                if skill_memory:  # Only add non-None results
                    skill_memories.append(skill_memory)
            except Exception as e:
                logger.error(f"Error extracting skill memory: {e}")
                continue

    # write skills to file and get zip paths
    skill_memory_with_paths = []
    with ContextThreadPoolExecutor(max_workers=min(len(skill_memories), 5)) as executor:
        futures = {
            executor.submit(_write_skills_to_file, skill_memory, info): skill_memory
            for skill_memory in skill_memories
        }
        for future in as_completed(futures):
            try:
                zip_path = future.result()
                skill_memory = futures[future]
                skill_memory_with_paths.append((skill_memory, zip_path))
            except Exception as e:
                logger.error(f"Error writing skills to file: {e}")
                continue

    # Create a mapping from old_memory_id to old memory for easy lookup
    old_memories_map = {mem.id: mem for mem in related_skill_memories}

    # upload skills to oss and get urls
    user_id = info.get("user_id", "unknown")
    urls_map = {}

    for skill_memory, zip_path in skill_memory_with_paths:
        try:
            # Delete old skill from OSS if this is an update
            if skill_memory.get("update", False) and skill_memory.get("old_memory_id"):
                old_memory_id = skill_memory["old_memory_id"]
                old_memory = old_memories_map.get(old_memory_id)

                if old_memory:
                    # Get old OSS path from the old memory's metadata
                    old_oss_path = getattr(old_memory.metadata, "url", None)

                    if old_oss_path:
                        try:
                            _delete_skills_from_oss(old_oss_path, OSS_CLIENT)
                            logger.info(f"Deleted old skill from OSS: {old_oss_path}")
                        except Exception as e:
                            logger.warning(f"Failed to delete old skill from OSS: {e}")

            # Upload new skill to OSS
            # Use the same filename as the local zip file
            zip_filename = os.path.basename(zip_path)
            oss_path = f"{OSS_DIR}{user_id}/{zip_filename}"

            # _upload_skills_to_oss returns the URL
            url = _upload_skills_to_oss(zip_path, oss_path, OSS_CLIENT)
            urls_map[id(skill_memory)] = url

            logger.info(f"Uploaded skill to OSS: {url}")
        except Exception as e:
            logger.error(f"Error uploading skill to OSS: {e}")
            urls_map[id(skill_memory)] = zip_path  # Fallback to local path

    # Create TextualMemoryItem objects
    skill_memory_items = []
    for skill_memory, zip_path in skill_memory_with_paths:
        try:
            url = urls_map.get(id(skill_memory), zip_path)
            skill_memory["url"] = url
            memory_item = create_skill_memory_item(skill_memory, info, zip_path)
            skill_memory_items.append(memory_item)
        except Exception as e:
            logger.error(f"Error creating skill memory item: {e}")
            continue

    return skill_memory_items

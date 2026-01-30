import json
import os
import shutil
import uuid
import zipfile

from concurrent.futures import as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.dependency import require_python_package
from memos.embedders.base import BaseEmbedder
from memos.graph_dbs.base import BaseGraphDB
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_reader.read_multi_modal import detect_lang
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.templates.skill_mem_prompt import (
    SKILL_MEMORY_EXTRACTION_PROMPT,
    SKILL_MEMORY_EXTRACTION_PROMPT_ZH,
    TASK_CHUNKING_PROMPT,
    TASK_CHUNKING_PROMPT_ZH,
    TASK_QUERY_REWRITE_PROMPT,
    TASK_QUERY_REWRITE_PROMPT_ZH,
)
from memos.types import MessageList


logger = get_logger(__name__)


def add_id_to_mysql(memory_id: str, mem_cube_id: str):
    """Add id to mysql, will deprecate this function in the future"""
    # TODO: tmp function, deprecate soon
    import requests

    skill_mysql_url = os.getenv("SKILLS_MYSQL_URL", "")
    skill_mysql_bearer = os.getenv("SKILLS_MYSQL_BEARER", "")

    if not skill_mysql_url or not skill_mysql_bearer:
        logger.warning("[PROCESS_SKILLS] SKILLS_MYSQL_URL or SKILLS_MYSQL_BEARER is not set")
        return None
    headers = {"Authorization": skill_mysql_bearer, "Content-Type": "application/json"}
    data = {"memCubeId": mem_cube_id, "skillId": memory_id}
    try:
        response = requests.post(skill_mysql_url, headers=headers, json=data)

        logger.info(f"[PROCESS_SKILLS] response: \n\n{response.json()}")
        logger.info(f"[PROCESS_SKILLS] memory_id: \n\n{memory_id}")
        logger.info(f"[PROCESS_SKILLS] mem_cube_id: \n\n{mem_cube_id}")
        logger.info(f"[PROCESS_SKILLS] skill_mysql_url: \n\n{skill_mysql_url}")
        logger.info(f"[PROCESS_SKILLS] skill_mysql_bearer: \n\n{skill_mysql_bearer}")
        logger.info(f"[PROCESS_SKILLS] headers: \n\n{headers}")
        logger.info(f"[PROCESS_SKILLS] data: \n\n{data}")

        return response.json()
    except Exception as e:
        logger.warning(f"[PROCESS_SKILLS] Error adding id to mysql: {e}")
        return None


@require_python_package(
    import_name="alibabacloud_oss_v2",
    install_command="pip install alibabacloud-oss-v2",
)
def create_oss_client(oss_config: dict[str, Any] | None = None) -> Any:
    import alibabacloud_oss_v2 as oss

    credentials_provider = oss.credentials.EnvironmentVariableCredentialsProvider()

    # load SDK's default configuration, and set credential provider
    cfg = oss.config.load_default()
    cfg.credentials_provider = credentials_provider
    cfg.region = oss_config.get("region", os.getenv("OSS_REGION"))
    cfg.endpoint = oss_config.get("endpoint", os.getenv("OSS_ENDPOINT"))
    client = oss.Client(cfg)

    return client


def _reconstruct_messages_from_memory_items(memory_items: list[TextualMemoryItem]) -> MessageList:
    reconstructed_messages = []
    seen = set()  # Track (role, content) tuples to detect duplicates

    for memory_item in memory_items:
        for source_message in memory_item.metadata.sources:
            try:
                role = source_message.role
                content = source_message.content

                # Create a tuple for deduplication
                message_key = (role, content)

                # Only add if not seen before (keep first occurrence)
                if message_key not in seen:
                    reconstructed_messages.append({"role": role, "content": content})
                    seen.add(message_key)
            except Exception as e:
                logger.warning(f"[PROCESS_SKILLS] Error reconstructing message: {e}")
                continue

    return reconstructed_messages


def _preprocess_extract_messages(
    history: MessageList, messages: MessageList
) -> (MessageList, MessageList):
    """Process data and check whether to extract skill memory"""
    history = history[-20:]
    if (len(history) + len(messages)) < 10:
        # TODO: maybe directly return []
        logger.warning("[PROCESS_SKILLS] Not enough messages to extract skill memory")
    return history, messages


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
    lang = detect_lang(messages_context)
    template = TASK_CHUNKING_PROMPT_ZH if lang == "zh" else TASK_CHUNKING_PROMPT
    prompt = [{"role": "user", "content": template.replace("{{messages}}", messages_context)}]
    for attempt in range(3):
        try:
            skills_llm = os.getenv("SKILLS_LLM", None)
            llm_kwargs = {"model_name_or_path": skills_llm} if skills_llm else {}
            response_text = llm.generate(prompt, **llm_kwargs)
            response_json = json.loads(response_text.replace("```json", "").replace("```", ""))
            break
        except Exception as e:
            logger.warning(f"[PROCESS_SKILLS] LLM generate failed (attempt {attempt + 1}): {e}")
            if attempt == 2:
                logger.warning(
                    "[PROCESS_SKILLS] LLM generate failed after 3 retries, returning empty dict"
                )
                response_json = []
                break

    task_chunks = {}
    for item in response_json:
        task_name = item["task_name"]
        message_indices = item["message_indices"]
        for indices in message_indices:
            # Validate that indices is a list/tuple with exactly 2 elements
            if isinstance(indices, list) and len(indices) == 1:
                start, end = indices[0], indices[0] + 1
            elif isinstance(indices, int):
                start, end = indices, indices + 1
            elif isinstance(indices, list) and len(indices) == 2:
                start, end = indices[0], indices[1] + 1
            else:
                logger.warning(
                    f"[PROCESS_SKILLS] Invalid message indices format for task '{task_name}': {indices}, skipping"
                )
                continue
            task_chunks.setdefault(task_name, []).extend(messages[start:end])
    return task_chunks


def _extract_skill_memory_by_llm(
    messages: MessageList,
    old_memories: list[TextualMemoryItem],
    llm: BaseLLM,
    chat_history: MessageList,
    chat_history_max_length: int = 5000,
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
            "examples": mem["metadata"]["examples"],
            "tags": mem["metadata"]["tags"],
            "scripts": mem["metadata"].get("scripts"),
            "others": mem["metadata"].get("others"),
        }
        for mem in old_memories_dict
    ]

    # Prepare conversation context
    messages_context = "\n".join(
        [f"{message['role']}: {message['content']}" for message in messages]
    )

    # Prepare history context
    chat_history_context = "\n".join(
        [f"{history['role']}: {history['content']}" for history in chat_history]
    )
    chat_history_context = chat_history_context[-chat_history_max_length:]

    # Prepare old memories context
    old_memories_context = json.dumps(old_mem_references, ensure_ascii=False, indent=2)

    # Prepare prompt
    lang = detect_lang(messages_context)
    template = SKILL_MEMORY_EXTRACTION_PROMPT_ZH if lang == "zh" else SKILL_MEMORY_EXTRACTION_PROMPT
    prompt_content = (
        template.replace("{old_memories}", old_memories_context)
        .replace("{messages}", messages_context)
        .replace("{chat_history}", chat_history_context)
    )

    prompt = [{"role": "user", "content": prompt_content}]
    logger.info(f"[Skill Memory]: Prompt {prompt_content}")

    # Call LLM to extract skill memory with retry logic
    for attempt in range(3):
        try:
            # Only pass model_name_or_path if SKILLS_LLM is set
            skills_llm = os.getenv("SKILLS_LLM", None)
            llm_kwargs = {"model_name_or_path": skills_llm} if skills_llm else {}
            response_text = llm.generate(prompt, **llm_kwargs)
            # Clean up response (remove Markdown code blocks if present)
            logger.info(f"[Skill Memory]: response_text {response_text}")
            response_text = response_text.strip()
            response_text = response_text.replace("```json", "").replace("```", "").strip()

            # Parse JSON response
            skill_memory = json.loads(response_text)

            # If LLM returns null (parsed as None), log and return None
            if skill_memory is None:
                logger.info(
                    "[PROCESS_SKILLS] No skill memory extracted from conversation (LLM returned null)"
                )
                return None

            return skill_memory

        except json.JSONDecodeError as e:
            logger.warning(f"[PROCESS_SKILLS] JSON decode failed (attempt {attempt + 1}): {e}")
            logger.debug(f"[PROCESS_SKILLS] Response text: {response_text}")
            if attempt == 2:
                logger.warning("[PROCESS_SKILLS] Failed to parse skill memory after 3 retries")
                return None
        except Exception as e:
            logger.warning(
                f"[PROCESS_SKILLS] LLM skill memory extraction failed (attempt {attempt + 1}): {e}"
            )
            if attempt == 2:
                logger.warning(
                    "[PROCESS_SKILLS] LLM skill memory extraction failed after 3 retries"
                )
                return None

    return None


def _recall_related_skill_memories(
    task_type: str,
    messages: MessageList,
    searcher: Searcher,
    llm: BaseLLM,
    rewrite_query: bool,
    info: dict[str, Any],
    mem_cube_id: str,
) -> list[TextualMemoryItem]:
    query = _rewrite_query(task_type, messages, llm, rewrite_query)
    related_skill_memories = searcher.search(
        query,
        top_k=5,
        memory_type="SkillMemory",
        info=info,
        include_skill_memory=True,
        user_name=mem_cube_id,
    )

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
    lang = detect_lang(messages_context)
    template = TASK_QUERY_REWRITE_PROMPT_ZH if lang == "zh" else TASK_QUERY_REWRITE_PROMPT
    prompt_content = template.replace("{task_type}", task_type).replace(
        "{messages}", messages_context
    )
    prompt = [{"role": "user", "content": prompt_content}]

    # Call LLM to rewrite the query with retry logic
    for attempt in range(3):
        try:
            response_text = llm.generate(prompt)
            # Clean up response (remove any markdown formatting if present)
            response_text = response_text.strip()
            logger.info(f"[PROCESS_SKILLS] Rewritten query for task '{task_type}': {response_text}")
            return response_text
        except Exception as e:
            logger.warning(
                f"[PROCESS_SKILLS] LLM query rewrite failed (attempt {attempt + 1}): {e}"
            )
            if attempt == 2:
                logger.warning(
                    "[PROCESS_SKILLS] LLM query rewrite failed after 3 retries, returning first message content"
                )
                return messages[0]["content"] if messages else ""

    # Fallback (should not reach here due to return in exception handling)
    return messages[0]["content"] if messages else ""


@require_python_package(
    import_name="alibabacloud_oss_v2",
    install_command="pip install alibabacloud-oss-v2",
)
def _upload_skills_to_oss(local_file_path: str, oss_file_path: str, client: Any) -> str:
    import alibabacloud_oss_v2 as oss

    result = client.put_object_from_file(
        request=oss.PutObjectRequest(
            bucket=os.getenv("OSS_BUCKET_NAME"),
            key=oss_file_path,
        ),
        filepath=local_file_path,
    )

    if result.status_code != 200:
        logger.warning("[PROCESS_SKILLS] Failed to upload skill to OSS")
        return ""

    # Construct and return the URL
    bucket_name = os.getenv("OSS_BUCKET_NAME")
    endpoint = os.getenv("OSS_ENDPOINT").replace("https://", "").replace("http://", "")
    url = f"https://{bucket_name}.{endpoint}/{oss_file_path}"
    return url


@require_python_package(
    import_name="alibabacloud_oss_v2",
    install_command="pip install alibabacloud-oss-v2",
)
def _delete_skills_from_oss(oss_file_path: str, client: Any) -> Any:
    import alibabacloud_oss_v2 as oss

    result = client.delete_object(
        oss.DeleteObjectRequest(
            bucket=os.getenv("OSS_BUCKET_NAME"),
            key=oss_file_path,
        )
    )
    return result


def _write_skills_to_file(
    skill_memory: dict[str, Any], info: dict[str, Any], skills_dir_config: dict[str, Any]
) -> str:
    user_id = info.get("user_id", "unknown")
    skill_name = skill_memory.get("name", "unnamed_skill").replace(" ", "_").lower()

    # Create tmp directory for user if it doesn't exist
    tmp_dir = Path(skills_dir_config["skills_local_dir"]) / user_id
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # Create skill directory directly in tmp_dir
    skill_dir = tmp_dir / skill_name
    skill_dir.mkdir(parents=True, exist_ok=True)

    # Generate SKILL.md content with frontmatter
    skill_md_content = f"""---
name: {skill_name}
description: {skill_memory.get("description", "")}
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
    examples = skill_memory.get("examples", [])
    if examples:
        skill_md_content += "\n## Examples\n"
        for idx, example in enumerate(examples, 1):
            skill_md_content += f"\n### Example {idx}\n```markdown\n{example}\n```\n"

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
    skill_md_path = skill_dir / "SKILL.md"
    with open(skill_md_path, "w", encoding="utf-8") as f:
        f.write(skill_md_content)

    # Write separate markdown files from others
    if others and isinstance(others, dict):
        for key, value in others.items():
            if key.endswith(".md"):
                md_file_path = skill_dir / key
                with open(md_file_path, "w", encoding="utf-8") as f:
                    f.write(value)

    # If there are scripts, create a scripts directory with individual script files
    if scripts and isinstance(scripts, dict):
        scripts_dir = skill_dir / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)

        # Write each script to its own file
        for script_filename, script_content in scripts.items():
            # Ensure filename ends with .py
            if not script_filename.endswith(".py"):
                script_filename = f"{script_filename}.py"

            script_path = scripts_dir / script_filename
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script_content)

    # Create zip file in tmp_dir
    zip_filename = f"{skill_name}.zip"
    zip_path = tmp_dir / zip_filename

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        # Walk through the skill directory and add all files
        for file_path in skill_dir.rglob("*"):
            if file_path.is_file():
                # Use relative path from skill_dir for archive
                arcname = Path(skill_dir.name) / file_path.relative_to(skill_dir)
                zipf.write(str(file_path), str(arcname))

    logger.info(f"[PROCESS_SKILLS] Created skill zip file: {zip_path}")
    return str(zip_path)


def create_skill_memory_item(
    skill_memory: dict[str, Any], info: dict[str, Any], embedder: BaseEmbedder | None = None
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
        confidence=0.99,
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
        type="skills",
        info=info_,
        embedding=embedder.embed([memory_content])[0] if embedder else None,
        # Skill-specific fields
        name=skill_memory.get("name", ""),
        description=skill_memory.get("description", ""),
        procedure=skill_memory.get("procedure", ""),
        experience=skill_memory.get("experience", []),
        preference=skill_memory.get("preference", []),
        examples=skill_memory.get("examples", []),
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
    graph_db: BaseGraphDB | None = None,
    llm: BaseLLM | None = None,
    embedder: BaseEmbedder | None = None,
    rewrite_query: bool = True,
    oss_config: dict[str, Any] | None = None,
    skills_dir_config: dict[str, Any] | None = None,
    **kwargs,
) -> list[TextualMemoryItem]:
    # Validate required configurations
    if not oss_config:
        logger.warning("[PROCESS_SKILLS] OSS configuration is required for skill memory processing")
        return []

    if not skills_dir_config:
        logger.warning(
            "[PROCESS_SKILLS] Skills directory configuration is required for skill memory processing"
        )
        return []

    chat_history = kwargs.get("chat_history")
    if not chat_history or not isinstance(chat_history, list):
        chat_history = []
        logger.warning("[PROCESS_SKILLS] History is None in Skills")

    # Validate skills_dir has required keys
    required_keys = ["skills_local_dir", "skills_oss_dir"]
    missing_keys = [key for key in required_keys if key not in skills_dir_config]
    if missing_keys:
        logger.warning(
            f"[PROCESS_SKILLS] Skills directory configuration missing required keys: {', '.join(missing_keys)}"
        )
        return []

    oss_client = create_oss_client(oss_config)
    if not oss_client:
        logger.warning("[PROCESS_SKILLS] Failed to create OSS client")
        return []

    messages = _reconstruct_messages_from_memory_items(fast_memory_items)

    chat_history, messages = _preprocess_extract_messages(chat_history, messages)
    if not messages:
        return []

    messages = _add_index_to_message(messages)
    chat_history = _add_index_to_message(chat_history)

    task_chunks = _split_task_chunk_by_llm(llm, messages)
    if not task_chunks:
        logger.warning("[PROCESS_SKILLS] No task chunks found")
        return []

    # recall - get related skill memories for each task separately (parallel)
    related_skill_memories_by_task = {}
    with ContextThreadPoolExecutor(max_workers=5) as executor:
        recall_futures = {
            executor.submit(
                _recall_related_skill_memories,
                task_type=task,
                messages=msg,
                searcher=searcher,
                llm=llm,
                rewrite_query=rewrite_query,
                info=info,
                mem_cube_id=kwargs.get("user_name", info.get("user_id", "")),
            ): task
            for task, msg in task_chunks.items()
        }
        for future in as_completed(recall_futures):
            task_name = recall_futures[future]
            try:
                related_memories = future.result()
                related_skill_memories_by_task[task_name] = related_memories
            except Exception as e:
                logger.warning(
                    f"[PROCESS_SKILLS] Error recalling skill memories for task '{task_name}': {e}"
                )
                related_skill_memories_by_task[task_name] = []

    skill_memories = []
    with ContextThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(
                _extract_skill_memory_by_llm,
                messages,
                related_skill_memories_by_task.get(task_type, []),
                llm,
                chat_history,
            ): task_type
            for task_type, messages in task_chunks.items()
        }
        for future in as_completed(futures):
            try:
                skill_memory = future.result()
                if skill_memory:  # Only add non-None results
                    skill_memories.append(skill_memory)
            except Exception as e:
                logger.warning(f"[PROCESS_SKILLS] Error extracting skill memory: {e}")
                continue

    # write skills to file and get zip paths
    skill_memory_with_paths = []
    with ContextThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(
                _write_skills_to_file, skill_memory, info, skills_dir_config
            ): skill_memory
            for skill_memory in skill_memories
        }
        for future in as_completed(futures):
            try:
                zip_path = future.result()
                skill_memory = futures[future]
                skill_memory_with_paths.append((skill_memory, zip_path))
            except Exception as e:
                logger.warning(f"[PROCESS_SKILLS] Error writing skills to file: {e}")
                continue

    # Create a mapping from old_memory_id to old memory for easy lookup
    # Collect all related memories from all tasks
    all_related_memories = []
    for memories in related_skill_memories_by_task.values():
        all_related_memories.extend(memories)
    old_memories_map = {mem.id: mem for mem in all_related_memories}

    # upload skills to oss and set urls directly to skill_memory
    user_id = info.get("user_id", "unknown")

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
                            # delete old skill from OSS
                            zip_filename = Path(old_oss_path).name
                            old_oss_path = (
                                Path(skills_dir_config["skills_oss_dir"]) / user_id / zip_filename
                            ).as_posix()
                            _delete_skills_from_oss(old_oss_path, oss_client)
                            logger.info(
                                f"[PROCESS_SKILLS] Deleted old skill from OSS: {old_oss_path}"
                            )
                        except Exception as e:
                            logger.warning(
                                f"[PROCESS_SKILLS] Failed to delete old skill from OSS: {e}"
                            )

                    # delete old skill from graph db
                    if graph_db:
                        graph_db.delete_node_by_prams(memory_ids=[old_memory_id])
                        logger.info(
                            f"[PROCESS_SKILLS] Deleted old skill from graph db: {old_memory_id}"
                        )

            # Upload new skill to OSS
            # Use the same filename as the local zip file
            zip_filename = Path(zip_path).name
            oss_path = (
                Path(skills_dir_config["skills_oss_dir"]) / user_id / zip_filename
            ).as_posix()

            # _upload_skills_to_oss returns the URL
            url = _upload_skills_to_oss(
                local_file_path=str(zip_path), oss_file_path=oss_path, client=oss_client
            )

            # Set URL directly to skill_memory
            skill_memory["url"] = url

            logger.info(f"[PROCESS_SKILLS] Uploaded skill to OSS: {url}")
        except Exception as e:
            logger.warning(f"[PROCESS_SKILLS] Error uploading skill to OSS: {e}")
            skill_memory["url"] = ""  # Set to empty string if upload fails
        finally:
            # Clean up local files after upload
            try:
                zip_file = Path(zip_path)
                skill_dir = zip_file.parent / zip_file.stem
                # Delete zip file
                if zip_file.exists():
                    zip_file.unlink()
                # Delete skill directory
                if skill_dir.exists():
                    shutil.rmtree(skill_dir)
                logger.info(f"[PROCESS_SKILLS] Cleaned up local files: {zip_path} and {skill_dir}")
            except Exception as cleanup_error:
                logger.warning(f"[PROCESS_SKILLS] Error cleaning up local files: {cleanup_error}")

    # Create TextualMemoryItem objects
    skill_memory_items = []
    for skill_memory in skill_memories:
        try:
            memory_item = create_skill_memory_item(skill_memory, info, embedder)
            skill_memory_items.append(memory_item)
        except Exception as e:
            logger.warning(f"[PROCESS_SKILLS] Error creating skill memory item: {e}")
            continue

    # TODO: deprecate this funtion and call
    for skill_memory, skill_memory_item in zip(skill_memories, skill_memory_items, strict=False):
        if skill_memory.get("update", False) and skill_memory.get("old_memory_id", ""):
            continue
        add_id_to_mysql(
            memory_id=skill_memory_item.id,
            mem_cube_id=kwargs.get("user_name", info.get("user_id", "")),
        )
    return skill_memory_items

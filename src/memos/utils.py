import functools
import json
import re
import time
import traceback

from memos.log import get_logger


logger = get_logger(__name__)


def timed_with_status(
    func=None,
    *,
    log_prefix="",
    log_args=None,
    log_extra_args=None,
    fallback=None,
):
    """
    Parameters:
    - log: enable timing logs (default True)
    - log_prefix: prefix; falls back to function name
    - log_args: names to include in logs (str or list/tuple of str), values are taken from kwargs by name.
    - log_extra_args:
        - can be a dict: fixed contextual fields that are always attached to logs;
        - or a callable: like `fn(*args, **kwargs) -> dict`, used to dynamically generate contextual fields at runtime.
    """

    if isinstance(log_args, str):
        effective_log_args = [log_args]
    else:
        effective_log_args = list(log_args) if log_args else []

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            exc_type = None
            exc_message = None
            result = None
            success_flag = False

            try:
                result = fn(*args, **kwargs)
                success_flag = True
                return result
            except Exception as e:
                exc_type = type(e)
                stack_info = "".join(traceback.format_stack()[:-1])
                exc_message = f"{stack_info}{traceback.format_exc()}"
                success_flag = False

                if fallback is not None and callable(fallback):
                    result = fallback(e, *args, **kwargs)
                    return result
            finally:
                elapsed_ms = (time.perf_counter() - start) * 1000.0

                ctx_parts = []
                # 1) Collect parameters from kwargs by name
                for key in effective_log_args:
                    val = kwargs.get(key)
                    ctx_parts.append(f"{key}={val}")

                # 2) Support log_extra_args as dict or callable, so we can dynamically
                #    extract values from self or other runtime context
                extra_items = {}
                try:
                    if callable(log_extra_args):
                        extra_items = log_extra_args(*args, **kwargs) or {}
                    elif isinstance(log_extra_args, dict):
                        extra_items = log_extra_args
                except Exception as e:
                    logger.warning(f"[TIMER_WITH_STATUS] log_extra_args callback error: {e!r}")

                if extra_items:
                    ctx_parts.extend(f"{key}={val}" for key, val in extra_items.items())

                ctx_str = f" [{', '.join(ctx_parts)}]" if ctx_parts else ""

                status = "SUCCESS" if success_flag else "FAILED"
                status_info = f", status: {status}"
                if not success_flag and exc_type is not None:
                    status_info += (
                        f", error_type: {exc_type.__name__}, error_message: {exc_message}"
                    )

                msg = (
                    f"[TIMER_WITH_STATUS] {log_prefix or fn.__name__} "
                    f"took {elapsed_ms:.0f} ms{status_info}, args: {ctx_str}"
                )

                logger.info(msg)

        return wrapper

    if func is None:
        return decorator
    return decorator(func)


def timed(func=None, *, log=True, log_prefix=""):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = fn(*args, **kwargs)
            elapsed_ms = (time.perf_counter() - start) * 1000.0

            if log is not True:
                return result

            # 100ms threshold
            if elapsed_ms >= 100.0:
                logger.info(f"[TIMER] {log_prefix or fn.__name__} took {elapsed_ms:.0f} ms")

            return result

        return wrapper

    # Handle both @timed and @timed(log=True) cases
    if func is None:
        return decorator
    return decorator(func)


def extract_json_obj(text: str):
    """
    Safely extracts JSON from LLM response text with robust error handling.

    Args:
        text: Raw text response from LLM that may contain JSON

    Returns:
        Parsed JSON data (dict or list)

    Raises:
        ValueError: If no valid JSON can be extracted
    """
    if not text:
        raise ValueError("Empty input text")

    # Normalize the text
    text = text.strip()

    # Remove common code block markers
    patterns_to_remove = ["json```", "```python", "```json", "latex```", "```latex", "```"]
    for pattern in patterns_to_remove:
        text = text.replace(pattern, "")

    # Try: direct JSON parse first
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError as e:
        logger.info(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)

    # Fallback 1: Extract JSON using regex
    json_pattern = r"\{[\s\S]*\}|\[[\s\S]*\]"
    matches = re.findall(json_pattern, text)
    if matches:
        try:
            return json.loads(matches[0])
        except json.JSONDecodeError as e:
            logger.info(f"Failed to parse JSON from text: {text}. Error: {e!s}", exc_info=True)

    # Fallback 2: Handle malformed JSON (common LLM issues)
    try:
        # Try adding missing quotes around keys
        text = re.sub(r"([\{\s,])(\w+)(:)", r'\1"\2"\3', text)
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse JSON from text: {text}. Error: {e!s}")
        logger.error("Full traceback:\n" + traceback.format_exc())
        raise ValueError(text) from e


def extract_list_items(text: str, bullet_prefixes: tuple[str, ...] = ("- ",)) -> list[str]:
    """
    Extract bullet list items from LLM output where each item is on a single line
    starting with a given bullet prefix (default: "- ").

    This function is designed to be robust to common LLM formatting variations,
    following similar normalization practices as `extract_json_obj`.

    Behavior:
    - Strips common code-fence markers (```json, ```python, ``` etc.).
    - Collects all lines that start with any of the provided `bullet_prefixes`.
    - Tolerates the "• " bullet as a loose fallback.
    - Unescapes common sequences like "\\n" and "\\t" within items.
    - If no bullet lines are found, falls back to attempting to parse a JSON array
      (using `extract_json_obj`) and returns its string elements.

    Args:
        text: Raw text response from LLM.
        bullet_prefixes: Tuple of accepted bullet line prefixes.

    Returns:
        List of extracted items (strings). Returns an empty list if none can be parsed.
    """
    if not text:
        return []

    # Normalize the text similar to extract_json_obj
    normalized = text.strip()
    patterns_to_remove = ["json```", "```python", "```json", "latex```", "```latex", "```"]
    for pattern in patterns_to_remove:
        normalized = normalized.replace(pattern, "")
    normalized = normalized.replace("\r\n", "\n")

    lines = normalized.splitlines()
    items: list[str] = []
    seen: set[str] = set()

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        matched = False
        for prefix in bullet_prefixes:
            if line.startswith(prefix):
                content = line[len(prefix) :].strip()
                content = content.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
                if content and content not in seen:
                    items.append(content)
                    seen.add(content)
                matched = True
                break

        if matched:
            continue

    if items:
        return items
    else:
        logger.error(f"Fail to parse {text}")

    return []


def extract_list_items_in_answer(
    text: str, bullet_prefixes: tuple[str, ...] = ("- ",)
) -> list[str]:
    """
    Extract list items specifically from content enclosed within `<answer>...</answer>` tags.

    - When one or more `<answer>...</answer>` blocks are present, concatenates their inner
      contents with newlines and parses using `extract_list_items`.
    - When no `<answer>` block is found, falls back to parsing the entire input with
      `extract_list_items`.
    - Case-insensitive matching of the `<answer>` tag.

    Args:
        text: Raw text that may contain `<answer>...</answer>` blocks.
        bullet_prefixes: Accepted bullet prefixes (default: strictly `"- "`).

    Returns:
        List of extracted items (strings), or an empty list when nothing is parseable.
    """
    if not text:
        return []

    try:
        normalized = text.strip().replace("\r\n", "\n")
        # Ordered, exact-case matching for <answer> blocks: answer -> Answer -> ANSWER
        tag_variants = ["answer", "Answer", "ANSWER"]
        matches: list[str] = []
        for tag in tag_variants:
            matches = re.findall(rf"<{tag}>([\s\S]*?)</{tag}>", normalized)
            if matches:
                break
        # Fallback: case-insensitive matching if none of the exact-case variants matched
        if not matches:
            matches = re.findall(r"<answer>([\s\S]*?)</answer>", normalized, flags=re.IGNORECASE)

        if matches:
            combined = "\n".join(m.strip() for m in matches if m is not None)
            return extract_list_items(combined, bullet_prefixes=bullet_prefixes)

        # Fallback: parse the whole text if tags are absent
        return extract_list_items(normalized, bullet_prefixes=bullet_prefixes)
    except Exception as e:
        logger.info(f"Failed to extract items within <answer> tags: {e!s}", exc_info=True)
        # Final fallback: attempt direct list extraction
        try:
            return extract_list_items(text, bullet_prefixes=bullet_prefixes)
        except Exception:
            return []

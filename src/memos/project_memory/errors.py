"""项目记忆报错的稳定原因标识（`reason`）。

算法报错原来只有一句中文 `message`，工程层只能按开头文字匹配。这里把每类报错对应到一个
不随措辞变化的标识，放进报错体的 `reason` 字段（插件给自己的异常类注册了处理函数，核心的
异常处理不动）。报错文字改了措辞时只要开头不变，标识不变；单测逐条核对。
"""

from __future__ import annotations

from typing import Any


# （message 开头, HTTP 状态, reason）；按顺序匹配，先写更具体的
REASONS: list[tuple[str, int, str]] = [
    ("Space 不存在", 404, "SPACE_NOT_FOUND"),
    ("主题不在这个 Space 里", 404, "TOPIC_NOT_FOUND"),
    ("未配置领域", 400, "SPACE_DOMAIN_NOT_CONFIGURED"),
    ("领域未登记", 400, "DOMAIN_NOT_REGISTERED"),
    ("同一批里领域重名", 400, "DOMAIN_DUPLICATE"),
    ("同一批里 domain_id 重复", 400, "DOMAIN_DUPLICATE"),
    ("每个 Space 最多", 400, "DOMAIN_LIMIT_EXCEEDED"),
    ("领域改名冲突", 400, "DOMAIN_RENAME_CONFLICT"),
    ("领域仍被主题引用", 400, "DOMAIN_IN_USE"),
    ("project_id 不能为空", 400, "FIELD_EMPTY"),
    ("space_name 不能为空", 400, "FIELD_EMPTY"),
    ("领域名称不能为空", 400, "FIELD_EMPTY"),
    ("domain_id 不能为空", 400, "FIELD_EMPTY"),
    ("filter", 400, "INVALID_FILTER"),
    ("project_item_types", 400, "INVALID_PARAM"),
    ("project_result_format", 400, "INVALID_PARAM"),
    ("user_id and space_ids are required", 422, "SCOPE_REQUIRED"),
    ("space_ids accepts at most", 422, "TOO_MANY_SPACES"),
    ("space_ids", 422, "INVALID_PARAM"),
    ("domains", 422, "INVALID_PARAM"),
]


def reason_of(message: Any) -> str | None:
    text = str(message or "")
    for prefix, _status, reason in REASONS:
        if text.startswith(prefix):
            return reason
    return None


def http_error(status: int, message: Any) -> Exception:
    """带 `reason` 的 HTTP 报错（插件注册了它的处理函数；没注册时按核心的 HTTPException 处理）。"""
    from memos.api.handlers.project_view import ProjectHTTPError

    return ProjectHTTPError(status, str(message), reason_of(message))


def from_service(e: Exception) -> Exception:
    """服务层的 LookupError / ValueError 转成带 reason 的 HTTP 报错。"""
    return http_error(404 if isinstance(e, LookupError) else 400, e)

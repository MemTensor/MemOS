"""
Profile (Attribute Tree) Mock Models.

Pydantic request/response models for the 3 new profile endpoints:
- CreateProfileTemplate
- BindProfile
- EditProfile

These are used for the mock phase only. No PolarDB or scheduler dependency.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from memos.api.product_models import BaseResponse


DEFAULT_PROFILE_CONFIG_ID = "default_config"


# =============================================================================
# Sub-models
# =============================================================================


class IdProfileMapping(BaseModel):
    """Single mapping entry for BindProfile: one id → one profile_config_id."""

    id: str = Field(..., description="User ID or Agent ID to bind")
    profile_config_id: str = Field(
        DEFAULT_PROFILE_CONFIG_ID,
        description="Profile template ID to bind to this id. Defaults to default_config.",
    )


# =============================================================================
# CreateProfileTemplate
# =============================================================================


class CreateProfileTemplateRequest(BaseModel):
    """
    Request for creating a new profile template.

    metadata example:
    {
        "客观档案": {
            "姓名": {
                "内容": "张三",
                "依据": "...",
                "algorithm_updatable": true
            }
        },
        "人格状态": {
            "温柔程度": {
                "当前描述": "语气柔和",
                "变化趋势": "上升",
                "依据": "...",
                "algorithm_updatable": true
            }
        }
    }
    """

    metadata: dict[str, Any] = Field(
        ...,
        description="Profile template structure with categories and fields",
    )


class CreateProfileTemplateResponse(BaseResponse):
    """Response for CreateProfileTemplate. data contains profile_config_id."""

    data: dict[str, Any] | None = Field(
        None, description="Response data containing profile_config_id"
    )


# =============================================================================
# BindProfile
# =============================================================================


class BindProfileRequest(BaseModel):
    """
    Request for binding user/agent IDs to profile templates.

    Currently one ID can only bind to one template.
    If the same ID is already bound to the same template, it's idempotent.
    If bound to a different template, return an error.
    """

    id_profile_map: list[IdProfileMapping] = Field(
        ...,
        description="List of {id, profile_config_id} pairs to bind",
        min_length=1,
    )


class BindProfileResponse(BaseResponse):
    """Response for BindProfile. data contains profile_instance_id list."""

    data: dict[str, Any] | None = Field(
        None,
        description="Response data containing profile_instance_id list",
    )


# =============================================================================
# EditProfile
# =============================================================================


class EditProfileRequest(BaseModel):
    """
    Request for editProfileConfig (§3.3).

    Rules (from final spec):
    - If already bound: update the specified fields.
    - If not yet bound: auto-bind to the given template, then apply updates.
    - If already bound to a *different* template: return 400.
    - Update field values regardless of whether they had values before.
    - Check fields with default values: if empty, fill with defaults.
    - If a field is not in the template tree: add it to this user's instance only
      (does not affect the template or other users).
    - Fields marked with algorithm_updatable=false are locked from future
      algorithm extraction overwrites.

    metadata example:
    {
        "姓名": {"内容": "张三", "algorithm_updatable": false},
        "性别": {"内容": "女"},
        "Smauel称呼我": {"内容": "小张", "algorithm_updatable": false}
    }
    """

    id: str = Field(..., description="User ID or Agent ID whose profile to edit")
    profile_config_id: str = Field(
        DEFAULT_PROFILE_CONFIG_ID,
        description="Profile template ID. Defaults to default_config.",
    )
    metadata: dict[str, Any] | None = Field(
        None,
        description=(
            "Fields to update. Keys are field names, values are field data dicts "
            "(e.g. {'内容': '张三', 'algorithm_updatable': false}). "
            "Fields with algorithm_updatable=false are locked from algorithm overwrites."
        ),
    )


class EditProfileResponse(BaseResponse):
    """Response for editProfileConfig. data contains profile_instance_id."""

    data: dict[str, Any] | None = Field(
        None,
        description="Response data containing profile_instance_id",
    )

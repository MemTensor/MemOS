"""
Profile (Attribute Tree) Mock Handler.

Fully synchronous, in-memory mock implementation.
No PolarDB, no scheduler, no embedding — just dict storage.

This handler is standalone and does NOT depend on HandlerDependencies.
"""

from __future__ import annotations

import copy
import uuid

from typing import Any

from fastapi import HTTPException

from memos.api.profile_models import (
    DEFAULT_PROFILE_CONFIG_ID,
    BindProfileRequest,
    BindProfileResponse,
    CreateProfileTemplateRequest,
    CreateProfileTemplateResponse,
    EditProfileRequest,
    EditProfileResponse,
)
from memos.log import get_logger


logger = get_logger(__name__)

DEFAULT_PROFILE_TEMPLATE: dict[str, dict[str, dict[str, Any]]] = {
    "客观档案": {
        "姓名": {"内容": "", "证据": ""},
        "性别": {"内容": "", "证据": ""},
        "年龄": {"内容": "", "证据": ""},
        "当前关系状态": {"内容": "单身", "证据": ""},
    },
    "人格状态": {
        "温柔程度": {"当前描述": "中性", "变化趋势": "稳定", "依据": ""},
        "自尊表现": {"当前描述": "中性", "变化趋势": "稳定", "依据": ""},
        "依附感": {"当前描述": "中性", "变化趋势": "稳定", "依据": ""},
        "强势感": {"当前描述": "中性", "变化趋势": "稳定", "依据": ""},
        "退让程度": {"当前描述": "中性", "变化趋势": "稳定", "依据": ""},
    },
}


class ProfileMockStore:
    """
    In-memory storage for profile templates, bindings, and instances.

    Data is lost on server restart — this is intentional for a mock.

    Storage layout:
        templates:  {profile_config_id: {metadata_dict}}
        bindings:   {entity_id: profile_config_id}
        instances:  {profile_instance_id: {merged_profile_data}}
    """

    def __init__(self) -> None:
        self.templates: dict[str, dict[str, Any]] = {
            DEFAULT_PROFILE_CONFIG_ID: copy.deepcopy(DEFAULT_PROFILE_TEMPLATE)
        }
        self.bindings: dict[str, str] = {}
        self.instances: dict[str, dict[str, Any]] = {}

    def make_instance_id(self, entity_id: str, profile_config_id: str) -> str:
        """Generate profile_instance_id: entity_id + '_' + profile_config_id."""
        return f"{entity_id}_{profile_config_id}"


# Singleton store shared across all requests
_store = ProfileMockStore()


def get_store() -> ProfileMockStore:
    """Get the global mock store instance."""
    return _store


class ProfileHandler:
    """Mock handler for profile (attribute tree) endpoints."""

    def __init__(self, store: ProfileMockStore | None = None) -> None:
        self.store = store or get_store()

    # -----------------------------------------------------------------
    # CreateProfileTemplate
    # -----------------------------------------------------------------
    async def create_template(
        self, req: CreateProfileTemplateRequest
    ) -> CreateProfileTemplateResponse:
        """
        Create a new profile template.

        Generates a UUID as profile_config_id, stores the template metadata.
        """
        profile_config_id = f"tpl_{uuid.uuid4().hex[:12]}"
        self.store.templates[profile_config_id] = copy.deepcopy(req.metadata)

        logger.info(
            "Created profile template %s with %d categories",
            profile_config_id,
            len(req.metadata),
        )

        return CreateProfileTemplateResponse(
            code=200,
            message="success",
            data={"profile_config_id": profile_config_id},
        )

    # -----------------------------------------------------------------
    # BindProfile
    # -----------------------------------------------------------------
    async def bind_profile(self, req: BindProfileRequest) -> BindProfileResponse:
        """
        Bind user/agent IDs to profile templates.

        Rules:
        - If not yet bound: create binding + instantiate template defaults
        - If already bound to SAME template: idempotent, return existing instance_id
        - If already bound to DIFFERENT template: return 400 error
        """
        instance_ids: list[str] = []

        for mapping in req.id_profile_map:
            entity_id = mapping.id
            profile_config_id = mapping.profile_config_id

            # Check if template exists
            if profile_config_id not in self.store.templates:
                raise HTTPException(
                    status_code=400,
                    detail=f"Template '{profile_config_id}' not found. "
                    f"Please create it first via CreateProfileTemplate.",
                )

            # Check existing binding
            existing = self.store.bindings.get(entity_id)

            if existing is not None and existing != profile_config_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Entity '{entity_id}' is already bound to template "
                    f"'{existing}'. Cannot rebind to '{profile_config_id}'. "
                    f"One ID can only bind to one template.",
                )

            instance_id = self.store.make_instance_id(entity_id, profile_config_id)

            if existing == profile_config_id:
                # Idempotent — already bound to same template
                logger.info(
                    "Entity %s already bound to %s, idempotent",
                    entity_id,
                    profile_config_id,
                )
            else:
                # New binding — instantiate template with defaults filled in
                self.store.bindings[entity_id] = profile_config_id
                template_data = self.store.templates[profile_config_id]
                self.store.instances[instance_id] = copy.deepcopy(template_data)
                self._fill_defaults(instance_id)

                logger.info(
                    "Bound entity %s to template %s → instance %s",
                    entity_id,
                    profile_config_id,
                    instance_id,
                )

            instance_ids.append(instance_id)

        return BindProfileResponse(
            code=200,
            message="success",
            data={"profile_instance_id": instance_ids},
        )

    # -----------------------------------------------------------------
    # EditProfile
    # -----------------------------------------------------------------
    async def edit_profile(self, req: EditProfileRequest) -> EditProfileResponse:
        """
        Edit profile values for a bound user/agent (editProfileConfig §3.3).

        Execution logic (per final spec):
        1. Update the passed-in fields' values, regardless of prior values.
        2. Check fields with default values; if empty, fill with defaults.
        3. If a field is not in the tree, add it to this user's instance only.
        4. Mark fields with algorithm_updatable from the metadata dict.
        """
        entity_id = req.id
        profile_config_id = req.profile_config_id or DEFAULT_PROFILE_CONFIG_ID
        instance_id = self.store.make_instance_id(entity_id, profile_config_id)

        # Ensure template exists (bootstrap default if needed)
        if profile_config_id not in self.store.templates:
            if profile_config_id == DEFAULT_PROFILE_CONFIG_ID:
                self.store.templates[profile_config_id] = copy.deepcopy(DEFAULT_PROFILE_TEMPLATE)
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"Template '{profile_config_id}' not found. "
                    "Please create it first via create_profile_template.",
                )

        # Auto-bind if not yet bound; reject cross-template edits
        existing_binding = self.store.bindings.get(entity_id)
        if existing_binding is None:
            self.store.bindings[entity_id] = profile_config_id
            template_data = self.store.templates[profile_config_id]
            self.store.instances[instance_id] = copy.deepcopy(template_data)
            self._fill_defaults(instance_id)
            logger.info("Auto-bound entity %s to template %s", entity_id, profile_config_id)
        elif existing_binding != profile_config_id:
            raise HTTPException(
                status_code=400,
                detail=f"Entity '{entity_id}' is already bound to template "
                f"'{existing_binding}'. Cannot edit with '{profile_config_id}'.",
            )

        # Apply field updates from metadata dict
        if req.metadata:
            instance_data = self.store.instances[instance_id]
            for field_name, field_value in req.metadata.items():
                updated = False
                for _category_name, category_fields in instance_data.items():
                    if isinstance(category_fields, dict) and field_name in category_fields:
                        if isinstance(field_value, dict):
                            category_fields[field_name].update(field_value)
                        else:
                            category_fields[field_name] = field_value
                        updated = True
                        break

                if not updated:
                    instance_data[field_name] = field_value

            logger.info("Updated %d field(s) for instance %s", len(req.metadata), instance_id)

        return EditProfileResponse(
            code=200,
            message="success",
            data={"profile_instance_id": instance_id},
        )

    # -----------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------
    def _fill_defaults(self, instance_id: str) -> None:
        """
        Ensure every field dict in a freshly instantiated instance has
        algorithm_updatable set to True (the default for new bindings).

        Template defaults (内容, 当前描述, 变化趋势, etc.) are already copied
        in via deepcopy; this pass only guarantees the control flag is present.
        """
        instance_data = self.store.instances.get(instance_id)
        if instance_data is None:
            return

        for _category_name, category_fields in instance_data.items():
            if not isinstance(category_fields, dict):
                continue
            for _field_name, field_value in category_fields.items():
                if not isinstance(field_value, dict):
                    continue
                # Ensure algorithm_updatable has a default
                if "algorithm_updatable" not in field_value:
                    field_value["algorithm_updatable"] = True

        logger.debug("Filled defaults for instance %s", instance_id)

    # -----------------------------------------------------------------
    # Get profile data (for SearchMemory mock)
    # -----------------------------------------------------------------
    def get_profile_for_entity(self, entity_id: str) -> list[dict[str, Any]]:
        """
        Retrieve stored profile data as profile_detail_list items.

        Used by SearchMemory mock when include_memory_view contains "profile".
        Returns a flat list of profile fields formatted for the API response.
        """
        binding = self.store.bindings.get(entity_id)
        if binding is None:
            return []

        instance_id = self.store.make_instance_id(entity_id, binding)
        instance_data = self.store.instances.get(instance_id)
        if instance_data is None:
            return []

        results: list[dict[str, Any]] = []
        for category_name, category_fields in instance_data.items():
            if not isinstance(category_fields, dict):
                continue
            for field_name, field_value in category_fields.items():
                if not isinstance(field_value, dict):
                    continue

                # Build content string from field value
                content_parts = []
                for k, v in field_value.items():
                    if k != "algorithm_updatable":
                        content_parts.append(f"{k}: {v}")
                content_str = "; ".join(content_parts) if content_parts else str(field_value)

                results.append(
                    {
                        "type": "ProfileMemory",
                        "content": f"{category_name}.{field_name}: {content_str}",
                        "score": 0.85,  # Mock score
                        "metadata": {
                            "profile_field": f"{category_name}.{field_name}",
                            "profile_category": category_name,
                            "algorithm_updatable": field_value.get("algorithm_updatable", True),
                            "template_id": binding,
                            "profile_instance_id": instance_id,
                        },
                    }
                )

        return results

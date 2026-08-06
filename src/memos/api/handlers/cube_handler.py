"""
Cube handler for memory cube management operations.

This module handles cube creation and registration through the HTTP API.
"""

from fastapi import HTTPException

from memos.api.handlers.base_handler import BaseHandler
from memos.api.product_models import (
    CreateCubeRequest,
    CreateCubeResponse,
    CreateCubeResponseData,
    RegisterCubeRequest,
    RegisterCubeResponse,
    RegisterCubeResponseData,
)
from memos.log import get_logger
from memos.mem_user.user_manager import UserManager


logger = get_logger(__name__)


class CubeHandler(BaseHandler):
    """Handler for memory cube management operations."""

    def __init__(self, *args, **kwargs):
        """Initialize CubeHandler with dependencies."""
        super().__init__(*args, **kwargs)
        # Initialize UserManager for cube operations
        # Use graph_db as the backend for user/cube management
        self.user_manager = UserManager()

    async def create_cube(self, request: CreateCubeRequest) -> CreateCubeResponse:
        """Create a new memory cube for a user.

        Args:
            request: Cube creation request

        Returns:
            CreateCubeResponse with created cube details

        Raises:
            HTTPException: If cube creation fails
        """
        try:
            # Validate owner exists
            if not self.user_manager.validate_user(request.owner_id):
                raise ValueError(f"Owner user '{request.owner_id}' does not exist or is inactive")

            # Create cube via UserManager
            created_cube_id = self.user_manager.create_cube(
                cube_name=request.cube_name,
                owner_id=request.owner_id,
                cube_path=request.cube_path,
                cube_id=request.cube_id,
            )

            logger.info(f"Created cube: {created_cube_id} for owner: {request.owner_id}")

            return CreateCubeResponse(
                code=200,
                message="Cube created successfully",
                data=CreateCubeResponseData(
                    cube_id=created_cube_id,
                    cube_name=request.cube_name,
                    owner_id=request.owner_id,
                ),
            )

        except ValueError as e:
            logger.error(f"Validation error creating cube: {e}")
            raise HTTPException(status_code=400, detail=str(e)) from e
        except Exception as e:
            logger.error(f"Failed to create cube: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Failed to create cube: {e!s}") from e

    async def register_cube(self, request: RegisterCubeRequest) -> RegisterCubeResponse:
        """Register an existing memory cube with the system.

        Note: This endpoint currently validates the request but the actual registration
        logic requires integration with MOSCore.register_mem_cube(), which is not
        directly available in the API server context. This is a placeholder that
        validates inputs and could be enhanced when the architecture supports it.

        Args:
            request: Cube registration request

        Returns:
            RegisterCubeResponse with registration details

        Raises:
            HTTPException: If registration fails
        """
        try:
            # Validate user exists if provided
            if request.user_id and not self.user_manager.validate_user(request.user_id):
                raise ValueError(f"User '{request.user_id}' does not exist or is inactive")

            # Note: Full registration logic requires MOSCore which isn't available
            # in the current API architecture. This validates the request.
            # Future work: integrate with MOSCore.register_mem_cube()

            # Use provided cube_id or fall back to name_or_path as identifier
            final_cube_id = request.mem_cube_id or request.mem_cube_name_or_path

            logger.info(f"Cube registration validated: {final_cube_id}")
            logger.warning(
                "register_cube endpoint validates inputs but full registration "
                "requires MOSCore integration (not yet available in API context)"
            )

            return RegisterCubeResponse(
                code=200,
                message="Cube registration request validated (full registration pending architecture support)",
                data=RegisterCubeResponseData(
                    cube_id=final_cube_id,
                    cube_name_or_path=request.mem_cube_name_or_path,
                ),
            )

        except ValueError as e:
            logger.error(f"Validation error registering cube: {e}")
            raise HTTPException(status_code=400, detail=str(e)) from e
        except Exception as e:
            logger.error(f"Failed to register cube: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Failed to register cube: {e!s}") from e

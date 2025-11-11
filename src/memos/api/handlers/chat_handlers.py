"""
Chat handler for chat functionality.

This module handles both streaming and complete chat responses with memory integration.
"""

import json
import traceback

from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from memos.api.product_models import APIChatCompleteRequest, ChatRequest
from memos.log import get_logger
from memos.mem_os.product_server import MOSServer


logger = get_logger(__name__)


def handle_chat_complete(
    chat_req: APIChatCompleteRequest,
    mos_server: Any,
    naive_mem_cube: Any,
) -> dict[str, Any]:
    """
    Chat with MemOS for complete response (non-streaming).

    Processes a chat request and returns the complete response with references.

    Args:
        chat_req: Chat complete request
        mos_server: MOS server instance
        naive_mem_cube: Memory cube instance

    Returns:
        Dictionary with response and references

    Raises:
        HTTPException: If chat fails
    """
    try:
        # Collect all responses from the server
        content, references = mos_server.chat(
            query=chat_req.query,
            user_id=chat_req.user_id,
            cube_id=chat_req.mem_cube_id,
            mem_cube=naive_mem_cube,
            history=chat_req.history,
            internet_search=chat_req.internet_search,
            moscube=chat_req.moscube,
            base_prompt=chat_req.base_prompt,
            top_k=chat_req.top_k,
            threshold=chat_req.threshold,
            session_id=chat_req.session_id,
        )

        # Return the complete response
        return {
            "message": "Chat completed successfully",
            "data": {"response": content, "references": references},
        }

    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(traceback.format_exc())) from err
    except Exception as err:
        logger.error(f"Failed to complete chat: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(traceback.format_exc())) from err


def handle_chat_stream(
    chat_req: ChatRequest,
    mos_server: MOSServer,
) -> StreamingResponse:
    """
    Chat with MemOS via Server-Sent Events (SSE) stream.

    Processes a chat request and streams the response back via SSE.

    Args:
        chat_req: Chat stream request
        mos_server: MOS server instance

    Returns:
        StreamingResponse with SSE formatted chat stream

    Raises:
        HTTPException: If stream initialization fails
    """
    try:

        def generate_chat_response():
            """Generate chat response as SSE stream."""
            try:
                # Directly yield from the generator without async wrapper
                yield from mos_server.chat_with_references(
                    query=chat_req.query,
                    user_id=chat_req.user_id,
                    cube_id=chat_req.mem_cube_id,
                    history=chat_req.history,
                    internet_search=chat_req.internet_search,
                    moscube=chat_req.moscube,
                    session_id=chat_req.session_id,
                )

            except Exception as e:
                logger.error(f"Error in chat stream: {e}")
                error_data = f"data: {json.dumps({'type': 'error', 'content': str(traceback.format_exc())})}\n\n"
                yield error_data

        return StreamingResponse(
            generate_chat_response(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Content-Type": "text/event-stream",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*",
            },
        )

    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(traceback.format_exc())) from err
    except Exception as err:
        logger.error(f"Failed to start chat stream: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(traceback.format_exc())) from err

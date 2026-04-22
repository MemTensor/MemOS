"""
API Analyzer for Scheduler

This module provides the APIAnalyzerForScheduler class that handles API requests
for search and add operations with reusable instance variables.
"""

import http.client
import json

from typing import Any
from urllib.parse import urlparse

import requests

from memos.api.product_models import APIADDRequest, APISearchRequest
from memos.api.routers.server_router import add_memories, search_memories
from memos.log import get_logger
from memos.types import MessageDict, SearchMode, UserContext


logger = get_logger(__name__)


class APIAnalyzerForScheduler:
    """
    API Analyzer class for scheduler operations.

    This class provides methods to interact with APIs for search and add operations,
    with reusable instance variables for better performance and configuration management.
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8002",
        default_headers: dict[str, str] | None = None,
        timeout: int = 30,
    ):
        """
        Initialize the APIAnalyzerForScheduler.

        Args:
            base_url: Base URL for API requests
            default_headers: Default headers to use for all requests
            timeout: Request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        # Default headers
        self.default_headers = default_headers or {"Content-Type": "application/json"}

        # Parse URL for http.client usage
        parsed_url = urlparse(self.base_url)
        self.host = parsed_url.hostname
        self.port = parsed_url.port or 8002
        self.is_https = parsed_url.scheme == "https"

        # Reusable connection for http.client
        self._connection = None

        # Attributes
        self.user_id = "test_user_id"
        self.mem_cube_id = "test_mem_cube_id"

        logger.info(f"APIAnalyzerForScheduler initialized with base_url: {self.base_url}")

    def _get_connection(self) -> http.client.HTTPConnection | http.client.HTTPSConnection:
        """
        Get or create a reusable HTTP connection.

        Returns:
            HTTP connection object
        """
        if self._connection is None:
            if self.is_https:
                self._connection = http.client.HTTPSConnection(self.host, self.port)
            else:
                self._connection = http.client.HTTPConnection(self.host, self.port)
        return self._connection

    def _close_connection(self):
        """Close the HTTP connection if it exists."""
        if self._connection:
            self._connection.close()
            self._connection = None

    def search(
        self, user_id: str, mem_cube_id: str, query: str, top_k: int = 50, use_requests: bool = True
    ) -> dict[str, Any]:
        """
        Search for memories using the product/search API endpoint.

        Args:
            user_id: User identifier
            mem_cube_id: Memory cube identifier
            query: Search query string
            top_k: Number of top_k results to return
            use_requests: Whether to use requests library (True) or http.client (False)

        Returns:
            Dictionary containing the API response
        """
        payload = {"user_id": user_id, "mem_cube_id": mem_cube_id, "query": query, "top_k": top_k}

        try:
            if use_requests:
                return self._search_with_requests(payload)
            else:
                return self._search_with_http_client(payload)
        except Exception as e:
            logger.error(f"Error in search operation: {e}")
            return {"error": str(e), "success": False}

    def _search_with_requests(self, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Perform search using requests library.

        Args:
            payload: Request payload

        Returns:
            Dictionary containing the API response
        """
        url = f"{self.base_url}/product/search"

        response = requests.post(
            url, headers=self.default_headers, data=json.dumps(payload), timeout=self.timeout
        )

        logger.info(f"Search request to {url} completed with status: {response.status_code}")

        try:
            return {
                "success": True,
                "status_code": response.status_code,
                "data": response.json() if response.content else {},
                "text": response.text,
            }
        except json.JSONDecodeError:
            return {
                "success": True,
                "status_code": response.status_code,
                "data": {},
                "text": response.text,
            }

    def _search_with_http_client(self, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Perform search using http.client.

        Args:
            payload: Request payload

        Returns:
            Dictionary containing the API response
        """
        conn = self._get_connection()

        try:
            conn.request("POST", "/product/search", json.dumps(payload), self.default_headers)

            response = conn.getresponse()
            data = response.read()
            response_text = data.decode("utf-8")

            logger.info(f"Search request completed with status: {response.status}")

            try:
                response_data = json.loads(response_text) if response_text else {}
            except json.JSONDecodeError:
                response_data = {}

            return {
                "success": True,
                "status_code": response.status,
                "data": response_data,
                "text": response_text,
            }
        except Exception as e:
            logger.error(f"Error in http.client search: {e}")
            return {"error": str(e), "success": False}

    def add(
        self, messages: list, user_id: str, mem_cube_id: str, use_requests: bool = True
    ) -> dict[str, Any]:
        """
        Add memories using the product/add API endpoint.

        Args:
            messages: List of message objects with role and content
            user_id: User identifier
            mem_cube_id: Memory cube identifier
            use_requests: Whether to use requests library (True) or http.client (False)

        Returns:
            Dictionary containing the API response
        """
        payload = {"messages": messages, "user_id": user_id, "mem_cube_id": mem_cube_id}

        try:
            if use_requests:
                return self._add_with_requests(payload)
            else:
                return self._add_with_http_client(payload)
        except Exception as e:
            logger.error(f"Error in add operation: {e}")
            return {"error": str(e), "success": False}

    def _add_with_requests(self, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Perform add using requests library.

        Args:
            payload: Request payload

        Returns:
            Dictionary containing the API response
        """
        url = f"{self.base_url}/product/add"

        response = requests.post(
            url, headers=self.default_headers, data=json.dumps(payload), timeout=self.timeout
        )

        logger.info(f"Add request to {url} completed with status: {response.status_code}")

        try:
            return {
                "success": True,
                "status_code": response.status_code,
                "data": response.json() if response.content else {},
                "text": response.text,
            }
        except json.JSONDecodeError:
            return {
                "success": True,
                "status_code": response.status_code,
                "data": {},
                "text": response.text,
            }

    def _add_with_http_client(self, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Perform add using http.client.

        Args:
            payload: Request payload

        Returns:
            Dictionary containing the API response
        """
        conn = self._get_connection()

        try:
            conn.request("POST", "/product/add", json.dumps(payload), self.default_headers)

            response = conn.getresponse()
            data = response.read()
            response_text = data.decode("utf-8")

            logger.info(f"Add request completed with status: {response.status}")

            try:
                response_data = json.loads(response_text) if response_text else {}
            except json.JSONDecodeError:
                response_data = {}

            return {
                "success": True,
                "status_code": response.status,
                "data": response_data,
                "text": response_text,
            }
        except Exception as e:
            logger.error(f"Error in http.client add: {e}")
            return {"error": str(e), "success": False}

    def update_base_url(self, new_base_url: str):
        """
        Update the base URL and reinitialize connection parameters.

        Args:
            new_base_url: New base URL for API requests
        """
        self._close_connection()
        self.base_url = new_base_url.rstrip("/")

        # Re-parse URL
        parsed_url = urlparse(self.base_url)
        self.host = parsed_url.hostname
        self.port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
        self.is_https = parsed_url.scheme == "https"

        logger.info(f"Base URL updated to: {self.base_url}")

    def update_headers(self, headers: dict[str, str]):
        """
        Update default headers.

        Args:
            headers: New headers to merge with existing ones
        """
        self.default_headers.update(headers)
        logger.info("Headers updated")

    def __del__(self):
        """Cleanup method to close connection when object is destroyed."""
        self._close_connection()

    def analyze_service(self):
        # Example add operation
        messages = [
            {"role": "user", "content": "Where should I go for New Year's Eve in Shanghai?"},
            {
                "role": "assistant",
                "content": "You could head to the Bund for the countdown, attend a rooftop party, or enjoy the fireworks at Disneyland Shanghai.",
            },
        ]

        add_result = self.add(
            messages=messages, user_id="test_user_id", mem_cube_id="test_mem_cube_id"
        )
        print("Add result:", add_result)

        # Example search operation
        search_result = self.search(
            user_id="test_user_id",
            mem_cube_id="test_mem_cube_id",
            query="What are some good places to celebrate New Year's Eve in Shanghai?",
            top_k=50,
        )
        print("Search result:", search_result)

    def analyze_features(self):
        try:
            # Test basic search functionality
            search_result = self.search(
                user_id="test_user_id",
                mem_cube_id="test_mem_cube_id",
                query="What are some good places to celebrate New Year's Eve in Shanghai?",
                top_k=50,
            )
            print("Search result:", search_result)
        except Exception as e:
            logger.error(f"Feature analysis failed: {e}")


class DirectSearchMemoriesAnalyzer:
    """
    Direct analyzer for testing search_memories function
    Used for debugging and analyzing search_memories function behavior without starting a full API server
    """

    def __init__(self):
        """Initialize the analyzer"""
        # Import necessary modules
        self.APISearchRequest = APISearchRequest
        self.APIADDRequest = APIADDRequest
        self.search_memories = search_memories
        self.add_memories = add_memories
        self.UserContext = UserContext
        self.MessageDict = MessageDict

        # Initialize conversation history for continuous conversation support
        self.conversation_history = []
        self.current_session_id = None
        self.current_user_id = None
        self.current_mem_cube_id = None

        logger.info("DirectSearchMemoriesAnalyzer initialized successfully")

    def start_conversation(self, user_id="test_user", mem_cube_id="test_cube", session_id=None):
        """
        Start a new conversation session for continuous dialogue.

        Args:
            user_id: User ID for the conversation
            mem_cube_id: Memory cube ID for the conversation
            session_id: Session ID for the conversation (auto-generated if None)
        """
        self.current_user_id = user_id
        self.current_mem_cube_id = mem_cube_id
        self.current_session_id = (
            session_id or f"session_{hash(user_id + mem_cube_id)}_{len(self.conversation_history)}"
        )
        self.conversation_history = []

        logger.info(f"Started conversation session: {self.current_session_id}")
        print(f"🚀 Started new conversation session: {self.current_session_id}")
        print(f"   User ID: {self.current_user_id}")
        print(f"   Mem Cube ID: {self.current_mem_cube_id}")

    def add_to_conversation(self, user_message, assistant_message=None):
        """
        Add messages to the current conversation and store them in memory.

        Args:
            user_message: User's message content
            assistant_message: Assistant's response (optional)

        Returns:
            Result from add_memories function
        """
        if not self.current_session_id:
            raise ValueError("No active conversation session. Call start_conversation() first.")

        # Prepare messages for adding to memory
        messages = [{"role": "user", "content": user_message}]
        if assistant_message:
            messages.append({"role": "assistant", "content": assistant_message})

        # Add to conversation history
        self.conversation_history.extend(messages)

        # Create add request
        add_req = self.create_test_add_request(
            user_id=self.current_user_id,
            mem_cube_id=self.current_mem_cube_id,
            messages=messages,
            session_id=self.current_session_id,
        )

        print(f"💬 Adding to conversation (Session: {self.current_session_id}):")
        print(f"   User: {user_message}")
        if assistant_message:
            print(f"   Assistant: {assistant_message}")

        # Add to memory
        result = self.add_memories(add_req)
        print("   ✅ Added to memory successfully")

        return result

    def search_in_conversation(self, query, mode="fast", top_k=10, include_history=True):
        """
        Search memories within the current conversation context.

        Args:
            query: Search query
            mode: Search mode ("fast", "fine", or "mixture")
            top_k: Number of results to return
            include_history: Whether to include conversation history in the search

        Returns:
            Search results
        """
        if not self.current_session_id:
            raise ValueError("No active conversation session. Call start_conversation() first.")

        # Prepare chat history if requested
        chat_history = self.conversation_history if include_history else None

        # Create search request
        search_req = self.create_test_search_request(
            query=query,
            user_id=self.current_user_id,
            mem_cube_id=self.current_mem_cube_id,
            mode=mode,
            top_k=top_k,
            chat_history=chat_history,
            session_id=self.current_session_id,
        )

        print(f"🔍 Searching in conversation (Session: {self.current_session_id}):")
        print(f"   Query: {query}")
        print(f"   Mode: {mode}")
        print(f"   Top K: {top_k}")
        print(f"   Include History: {include_history}")
        print(f"   History Length: {len(self.conversation_history) if chat_history else 0}")

        # Perform search
        result = self.search_memories(search_req)

        print("   ✅ Search completed")
        if hasattr(result, "data") and result.data:
            total_memories = sum(
                len(mem_list) for mem_list in result.data.values() if isinstance(mem_list, list)
            )
            print(f"   📊 Found {total_memories} total memories")

        return result

    def test_continuous_conversation(self, mode=SearchMode.MIXTURE):
        """Test continuous conversation functionality"""
        print("=" * 80)
        print("Testing Continuous Conversation Functionality")
        print("=" * 80)

        try:
            # Start a conversation
            self.start_conversation(user_id="conv_test_user", mem_cube_id="conv_test_cube")

            # Prepare all conversation messages for batch addition
            all_messages = [
                {
                    "role": "user",
                    "content": "I'm planning a trip to Shanghai for New Year's Eve. What are some good places to visit?",
                },
                {
                    "role": "assistant",
                    "content": "Shanghai has many great places for New Year's Eve! You could visit the Bund for the countdown, go to a rooftop party, or enjoy fireworks at Disneyland Shanghai. The French Concession also has nice bars and restaurants.",
                },
                {"role": "user", "content": "What about food? Any restaurant recommendations?"},
                {
                    "role": "assistant",
                    "content": "For New Year's Eve dining in Shanghai, I'd recommend trying some local specialties like xiaolongbao at Din Tai Fung, or for a fancy dinner, you could book at restaurants in the Bund area with great views.",
                },
                {"role": "user", "content": "I'm on a budget though. Any cheaper alternatives?"},
                {
                    "role": "assistant",
                    "content": "For budget-friendly options, try street food in Yuyuan Garden area, local noodle shops, or food courts in shopping malls. You can also watch the fireworks from free public areas along the Huangpu River.",
                },
            ]

            # Add all conversation messages at once
            print("\n📝 Adding all conversation messages at once:")
            add_req = self.create_test_add_request(
                user_id=self.current_user_id,
                mem_cube_id=self.current_mem_cube_id,
                messages=all_messages,
                session_id=self.current_session_id,
            )

            print(
                f"💬 Adding {len(all_messages)} messages to conversation (Session: {self.current_session_id})"
            )
            self.add_memories(add_req)

            # Update conversation history
            self.conversation_history.extend(all_messages)
            print("   ✅ Added all messages to memory successfully")

            # Test searching within the conversation
            print("\n🔍 Testing search within conversation:")

            # Search for trip-related information
            self.search_in_conversation(
                query="New Year's Eve Shanghai recommendations", mode=mode, top_k=5
            )

            # Search for food-related information
            self.search_in_conversation(query="budget food Shanghai", mode=mode, top_k=3)

            # Search without conversation history
            self.search_in_conversation(
                query="Shanghai travel", mode=mode, top_k=3, include_history=False
            )

            print("\n✅ Continuous conversation test completed successfully!")
            return True

        except Exception as e:
            print(f"❌ Continuous conversation test failed: {e}")
            import traceback

            traceback.print_exc()
            return False

    def create_test_search_request(
        self,
        query="test query",
        user_id="test_user",
        mem_cube_id="test_cube",
        mode="fast",
        top_k=10,
        chat_history=None,
        session_id=None,
    ):
        """
        Create a test APISearchRequest object with the given parameters.

        Args:
            query: Search query string
            user_id: User ID for the request
            mem_cube_id: Memory cube ID for the request
            mode: Search mode ("fast" or "fine")
            top_k: Number of results to return
            chat_history: Chat history for context (optional)
            session_id: Session ID for the request (optional)

        Returns:
            APISearchRequest: A configured request object
        """
        return self.APISearchRequest(
            query=query,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mode=mode,
            top_k=top_k,
            chat_history=chat_history,
            session_id=session_id,
        )

    def create_test_add_request(
        self,
        user_id="test_user",
        mem_cube_id="test_cube",
        messages=None,
        memory_content=None,
        session_id=None,
        extract_mode=None,
        async_mode="sync",
    ):
        """
        Create a test APIADDRequest object with the given parameters.

        Args:
            user_id: User ID for the request
            mem_cube_id: Memory cube ID for the request
            messages: List of messages to add (optional)
            memory_content: Direct memory content to add (optional)
            session_id: Session ID for the request (optional)

        Returns:
            APIADDRequest: A configured request object
        """
        if messages is None and memory_content is None:
            # Default test messages
            messages = [
                {"role": "user", "content": "What's the weather like today?"},
                {
                    "role": "assistant",
                    "content": "I don't have access to real-time weather data, but you can check a weather app or website for current conditions.",
                },
            ]

        # Ensure we have a valid session_id
        if session_id is None:
            session_id = "test_session_" + str(hash(user_id + mem_cube_id))[:8]

        return self.APIADDRequest(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            messages=messages,
            memory_content=memory_content,
            session_id=session_id,
            doc_path=None,
            source="api_analyzer_test",
            chat_history=None,
            operation=None,
            mode=extract_mode,
            async_mode=async_mode,
        )

    def run_all_tests(self, mode=SearchMode.MIXTURE):
        """Run all available tests"""
        print("🚀 Starting comprehensive test suite")
        print("=" * 80)

        # Test continuous conversation functionality
        print("\n💬 Testing CONTINUOUS CONVERSATION functions:")
        try:
            self.test_continuous_conversation(mode=mode)
            print("✅ Continuous conversation test completed successfully")
        except Exception as e:
            print(f"❌ Continuous conversation test failed: {e}")

        print("\n" + "=" * 80)
        print("✅ All tests completed!")


# Example usage
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="API Analyzer for Memory Scheduler")
    parser.add_argument(
        "--mode",
        choices=["direct", "api"],
        default="direct",
        help="Test mode: 'direct' for direct function testing, 'api' for API testing (default: direct)",
    )

    args = parser.parse_args()

    if args.mode == "direct":
        # Direct test mode for search_memories and add_memories functions
        print("Using direct test mode")
        try:
            direct_analyzer = DirectSearchMemoriesAnalyzer()
            direct_analyzer.run_all_tests(mode=SearchMode.FINE)
        except Exception as e:
            print(f"Direct test mode failed: {e}")
            import traceback

            traceback.print_exc()
    else:
        # Original API test mode
        print("Using API test mode")
        analyzer = APIAnalyzerForScheduler()

        # Test add operation
        messages = [
            {"role": "user", "content": "Where should I go for New Year's Eve in Shanghai?"},
            {
                "role": "assistant",
                "content": "You could head to the Bund for the countdown, attend a rooftop party, or enjoy the fireworks at Disneyland Shanghai.",
            },
        ]

        add_result = analyzer.add(
            messages=messages, user_id="test_user_id", mem_cube_id="test_mem_cube_id"
        )
        print("Add result:", add_result)

        # Test search operation
        search_result = analyzer.search(
            user_id="test_user_id",
            mem_cube_id="test_mem_cube_id",
            query="What are some good places to celebrate New Year's Eve in Shanghai?",
            top_k=10,
        )
        print("Search result:", search_result)

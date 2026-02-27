import threading
import time
import unittest

from unittest.mock import MagicMock, patch

import requests
import uvicorn

from memos.extras.nli_model.client import NLIClient
from memos.extras.nli_model.server.serve import app
from memos.extras.nli_model.types import NLIResult


# We need to mock the NLIHandler to avoid loading the heavy model
# but we want to run the real FastAPI server.
class TestNLIClientIntegration(unittest.TestCase):
    server_thread = None
    stop_server = False
    port = 32533  # Use a different port for testing

    @classmethod
    def setUpClass(cls):
        # Patch the lifespan to inject a mock handler instead of real NLIHandler
        cls.mock_handler = MagicMock()
        cls.mock_handler.compare_one_to_many.return_value = [
            NLIResult.DUPLICATE,
            NLIResult.CONTRADICTION,
        ]

        # We need to patch the module where lifespan is defined/used or modify the global variable
        # Since 'app' is already imported, we can patch the global nli_handler in serve.py
        # But lifespan sets it on startup.

        # Let's patch NLIHandler class in serve.py so when lifespan instantiates it, it gets our mock
        cls.handler_patcher = patch("memos.extras.nli_model.server.serve.NLIHandler")
        cls.MockHandlerClass = cls.handler_patcher.start()
        cls.MockHandlerClass.return_value = cls.mock_handler

        # Start server in a thread
        def run_server():
            # Disable logs for uvicorn to keep test output clean
            config = uvicorn.Config(app, host="127.0.0.1", port=cls.port, log_level="error")
            cls.server = uvicorn.Server(config)
            cls.server.run()

        cls.server_thread = threading.Thread(target=run_server, daemon=True)
        cls.server_thread.start()

        # Wait for server to be ready
        cls._wait_for_server()

    @classmethod
    def tearDownClass(cls):
        # Stop the server
        if hasattr(cls, "server"):
            cls.server.should_exit = True
        if cls.server_thread:
            cls.server_thread.join(timeout=5)

        cls.handler_patcher.stop()

    @classmethod
    def _wait_for_server(cls):
        url = f"http://127.0.0.1:{cls.port}/docs"
        retries = 20
        for _ in range(retries):
            try:
                response = requests.get(url)
                if response.status_code == 200:
                    return
            except requests.ConnectionError:
                pass
            time.sleep(0.1)
        raise RuntimeError("Server failed to start")

    def setUp(self):
        self.client = NLIClient(base_url=f"http://127.0.0.1:{self.port}")
        # Reset mock calls before each test
        self.mock_handler.reset_mock()
        # Ensure default behavior
        self.mock_handler.compare_one_to_many.return_value = [
            NLIResult.DUPLICATE,
            NLIResult.CONTRADICTION,
        ]

    def test_real_server_compare_one_to_many(self):
        source = "I like apples."
        targets = ["I love fruit.", "I hate apples."]

        results = self.client.compare_one_to_many(source, targets)

        # Verify result
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], NLIResult.DUPLICATE)
        self.assertEqual(results[1], NLIResult.CONTRADICTION)

        # Verify server received the request
        self.mock_handler.compare_one_to_many.assert_called_once()
        args, _ = self.mock_handler.compare_one_to_many.call_args
        self.assertEqual(args[0], source)
        self.assertEqual(args[1], targets)

    def test_real_server_empty_targets(self):
        source = "I like apples."
        targets = []

        results = self.client.compare_one_to_many(source, targets)

        self.assertEqual(results, [])
        # Should not call handler because client handles empty list
        self.mock_handler.compare_one_to_many.assert_not_called()

    def test_real_server_handler_error(self):
        # Simulate handler error
        self.mock_handler.compare_one_to_many.side_effect = ValueError("Something went wrong")

        source = "I like apples."
        targets = ["I love fruit."]

        # Client should catch 500 and return UNRELATED
        results = self.client.compare_one_to_many(source, targets)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0], NLIResult.UNRELATED)


if __name__ == "__main__":
    unittest.main()

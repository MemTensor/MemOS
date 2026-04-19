"""Unit tests for the add_handler info-sanitization logic.

Validates the `custom_tags` / `info` round-trip fix: legitimate user keys
(`source_type`, `topic`, `agent_id`, ...) must survive untouched, while
reserved internal keys (`merged_from`) are namespaced under `user:<key>`.
"""

import unittest

from memos.api.handlers.add_handler import _namespace_user_info


class TestNamespaceUserInfo(unittest.TestCase):
    def test_empty_and_none_return_empty(self):
        self.assertEqual(_namespace_user_info(None), ({}, {}))
        self.assertEqual(_namespace_user_info({}), ({}, {}))

    def test_preserves_arbitrary_user_keys(self):
        info = {
            "source_type": "web",
            "topic": "real-estate",
            "agent_id": "agent-42",
            "app_id": "hermes",
            "source_url": "https://example.com",
        }
        preserved, renamed = _namespace_user_info(info)
        self.assertEqual(preserved, info)
        self.assertEqual(renamed, {})

    def test_preserves_keys_that_were_previously_stripped(self):
        # Regression: the old `list_all_fields()` strip dropped these because they
        # happened to match top-level metadata field names, even though the info
        # dict has its own namespace.
        info = {"source": "web", "tags": ["legacy-client-value"], "type": "note"}
        preserved, renamed = _namespace_user_info(info)
        self.assertEqual(preserved, info)
        self.assertEqual(renamed, {})

    def test_reserved_key_is_namespaced(self):
        info = {"merged_from": "user-provided-value", "topic": "earnings"}
        preserved, renamed = _namespace_user_info(info)
        self.assertEqual(
            preserved,
            {"user:merged_from": "user-provided-value", "topic": "earnings"},
        )
        self.assertEqual(renamed, {"merged_from": "user:merged_from"})


if __name__ == "__main__":
    unittest.main()

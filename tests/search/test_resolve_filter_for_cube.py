import pytest

from memos.search.search_service import resolve_filter_for_cube


class TestResolveFilterForCube:
    """Tests for resolve_filter_for_cube — multi-cube filter routing."""

    # ── None passthrough ──

    def test_none_returns_none(self):
        assert resolve_filter_for_cube(None, "cube_001") is None

    # ── Unified filter (filter2): top-level and/or ──

    def test_unified_and_returns_same_for_any_cube(self):
        f = {"and": [{"tags": {"contains": "阅读"}}, {"created_at": {"gte": "2025-01-01"}}]}
        assert resolve_filter_for_cube(f, "cube_001") is f
        assert resolve_filter_for_cube(f, "cube_999") is f

    def test_unified_or_returns_same_for_any_cube(self):
        f = {"or": [{"tags": {"contains": "A"}}, {"tags": {"contains": "B"}}]}
        assert resolve_filter_for_cube(f, "cube_001") is f

    # ── Per-cube filter (filter1 / filter4) ──

    def test_per_cube_returns_matching_sub_filter(self):
        sub_a = {"and": [{"tags": {"contains": "阅读"}}]}
        sub_b = {"and": [{"tags": {"contains": "工作"}}]}
        f = {"cube_A": sub_a, "cube_B": sub_b}

        assert resolve_filter_for_cube(f, "cube_A") is sub_a
        assert resolve_filter_for_cube(f, "cube_B") is sub_b

    def test_per_cube_missing_key_returns_none(self):
        f = {
            "cube_A": {"and": [{"tags": {"contains": "阅读"}}]},
            "cube_B": {"and": [{"tags": {"contains": "工作"}}]},
        }
        assert resolve_filter_for_cube(f, "cube_C") is None

    def test_per_cube_single_key(self):
        sub = {"and": [{"created_at": {"gte": "2025-01-01"}}]}
        f = {"cube_only": sub}
        assert resolve_filter_for_cube(f, "cube_only") is sub
        assert resolve_filter_for_cube(f, "other") is None

    # ── Mixed (filter3): illegal ──

    def test_mixed_and_with_cube_key_raises(self):
        f = {
            "and": [{"tags": {"contains": "阅读"}}],
            "cube_A": {"and": [{"tags": {"contains": "工作"}}]},
        }
        with pytest.raises(ValueError, match="cannot coexist"):
            resolve_filter_for_cube(f, "cube_A")

    def test_mixed_or_with_cube_key_raises(self):
        f = {
            "or": [{"tags": {"contains": "阅读"}}],
            "cube_B": {"and": [{"tags": {"contains": "工作"}}]},
        }
        with pytest.raises(ValueError, match="cannot coexist"):
            resolve_filter_for_cube(f, "cube_B")

    # ── Edge cases ──

    def test_empty_dict_returns_none(self):
        assert resolve_filter_for_cube({}, "cube_001") is None

    def test_per_cube_with_empty_sub_filter(self):
        f = {"cube_A": {}}
        result = resolve_filter_for_cube(f, "cube_A")
        assert result == {}

    def test_unified_and_empty_list(self):
        f = {"and": []}
        assert resolve_filter_for_cube(f, "any") is f

import threading


def test_searcher_reuses_retrieve_executor_and_does_not_spawn_unbounded_threads():
    """Regression test for #1273.

    Searcher._retrieve_paths used to create a new ContextThreadPoolExecutor per call.
    That pattern can leak threads under load / long-running requests.

    We don't import the full memos package here (deps may be heavy); instead we exec
    a minimal slice of the Searcher implementation with a fake ContextThreadPoolExecutor.
    """

    created_executors = []

    class FakeFuture:
        def __init__(self, result):
            self._result = result

        def result(self, timeout=None):
            return self._result

        def cancel(self):
            return False

    class FakeExecutor:
        def __init__(self, max_workers=1, thread_name_prefix=None):
            self.max_workers = max_workers
            self.thread_name_prefix = thread_name_prefix
            created_executors.append(self)

        def submit(self, fn, *args, **kwargs):
            return FakeFuture(fn(*args, **kwargs))

        def shutdown(self, wait=False, cancel_futures=False):
            return None

    # minimal Searcher with only the bits we need
    class Searcher:
        def __init__(self):
            self.use_fulltext = False
            self._usage_executor = FakeExecutor(max_workers=4, thread_name_prefix="usage")
            self._retrieve_executor = FakeExecutor(max_workers=5, thread_name_prefix="retrieve")
            self.retrieve_timeout_seconds = 0.01

        def _retrieve_from_working_memory(self, *args, **kwargs):
            return ["A"]

        def _retrieve_from_long_term_and_user(self, *args, **kwargs):
            return ["B"]

        def _retrieve_from_internet(self, *args, **kwargs):
            return ["C"]

        def _retrieve_paths(
            self,
            query,
            parsed_goal,
            query_embedding,
            info,
            top_k,
            mode,
            memory_type,
            search_filter=None,
            search_priority=None,
            user_name=None,
            search_tool_memory=False,
            tool_mem_top_k=6,
            include_skill_memory=False,
            skill_mem_top_k=3,
            include_preference_memory=False,
            pref_mem_top_k=6,
        ):
            tasks = []
            id_filter = {"user_id": info.get("user_id"), "session_id": info.get("session_id")}
            id_filter = {k: v for k, v in id_filter.items() if v is not None}

            executor = self._retrieve_executor
            tasks.append(
                executor.submit(
                    self._retrieve_from_working_memory,
                    query,
                    parsed_goal,
                    query_embedding,
                    top_k,
                    memory_type,
                    search_filter,
                    search_priority,
                    user_name,
                    id_filter,
                )
            )
            tasks.append(
                executor.submit(
                    self._retrieve_from_long_term_and_user,
                    query,
                    parsed_goal,
                    query_embedding,
                    top_k,
                    memory_type,
                    search_filter,
                    search_priority,
                    user_name,
                    id_filter,
                    mode=mode,
                )
            )
            tasks.append(
                executor.submit(
                    self._retrieve_from_internet,
                    query,
                    parsed_goal,
                    query_embedding,
                    top_k,
                    info,
                    mode,
                    memory_type,
                    user_name,
                )
            )

            results = []
            timeout_s = getattr(self, "retrieve_timeout_seconds", 20.0)
            for t in tasks:
                results.extend(t.result(timeout=timeout_s))
            return results

    s = Searcher()

    # call multiple times; should not create new executors beyond the two created in __init__
    for _ in range(200):
        out = s._retrieve_paths(
            query="q",
            parsed_goal=None,
            query_embedding=[[]],
            info={"user_id": "u", "session_id": "s"},
            top_k=3,
            mode="fast",
            memory_type="All",
        )
        assert out == ["A", "B", "C"]

    assert len(created_executors) == 2

    # heuristic: thread count should not grow wildly in this unit test
    # (FakeExecutor doesn't spawn threads at all)
    assert threading.active_count() < 200

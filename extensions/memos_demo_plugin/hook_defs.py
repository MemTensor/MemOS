"""Demo plugin-owned hook declarations.

Hooks that the plugin declares, triggers, and registers callbacks for are defined here.
CE-exposed hooks (e.g. add.before/after) are managed by CE's hook_defs.py; the plugin only needs to reference them.
"""

from memos.plugins.hook_defs import define_hook


class DemoH:
    """Demo plugin hook name constants."""

    # @hookable("demo.test") — auto-generates before/after
    TEST_BEFORE = "demo.test.before"
    TEST_AFTER = "demo.test.after"

    # Manually triggered via trigger_hook
    TEST_POST_PROCESS = "demo.test.post_process"
    REPORT_ENRICH = "demo.report.enrich"


# ── Custom hook declarations (@hookable-generated before/after need not be declared here) ──

define_hook(
    DemoH.TEST_POST_PROCESS,
    description="post-process result after demo test endpoint business logic runs",
    params=["request", "result"],
    pipe_key="result",
)

define_hook(
    DemoH.REPORT_ENRICH,
    description="after user activity report is generated, allows callbacks to extend report data",
    params=["user_id", "report"],
    pipe_key="report",
)

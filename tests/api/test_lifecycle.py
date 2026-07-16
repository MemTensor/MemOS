from memos.api.lifecycle import shutdown_components


class SchedulerStub:
    def __init__(self, fail_stop: bool = False):
        self.fail_stop = fail_stop
        self.calls = []

    def stop(self):
        self.calls.append("stop")
        if self.fail_stop:
            raise RuntimeError("stop failed")

    def rabbitmq_close(self):
        self.calls.append("rabbitmq_close")


def test_shutdown_components_stops_scheduler_before_rabbitmq_close():
    scheduler = SchedulerStub()

    shutdown_components({"mem_scheduler": scheduler})

    assert scheduler.calls == ["stop", "rabbitmq_close"]


def test_shutdown_components_still_closes_rabbitmq_when_stop_fails():
    scheduler = SchedulerStub(fail_stop=True)

    shutdown_components({"mem_scheduler": scheduler})

    assert scheduler.calls == ["stop", "rabbitmq_close"]

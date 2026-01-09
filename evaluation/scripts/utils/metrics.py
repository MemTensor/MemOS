import threading


class Metrics:
    def __init__(self):
        self.times_ms: list[float] = []
        self.success_count = 0
        self.fail_count = 0
        self.errors = {}
        self.lock = threading.Lock()

    def record(self, duration_s: float, success: bool, error_msg: str | None = None):
        ms = duration_s * 1000.0
        with self.lock:
            if success:
                self.times_ms.append(ms)
                self.success_count += 1
            else:
                self.fail_count += 1
                if error_msg:
                    short_err = error_msg[:200] if len(error_msg) > 200 else error_msg
                    self.errors[short_err] = self.errors.get(short_err, 0) + 1

    def summary(self) -> dict:
        with self.lock:
            if not self.times_ms:
                return {
                    "stats": {},
                    "counts": {"success": self.success_count, "failed": self.fail_count},
                    "errors": dict(self.errors),
                }
            sorted_times = sorted(self.times_ms)
            n = len(sorted_times)

            def percentile(p: int):
                if n == 1:
                    return sorted_times[0]
                k = max(0, min(n - 1, round((p / 100) * (n - 1))))
                return sorted_times[k]

            mean = sum(sorted_times) / n
            variance = sum((x - mean) ** 2 for x in sorted_times) / (n - 1) if n > 1 else 0.0
            return {
                "stats": {
                    "count": n,
                    "mean": mean,
                    "median": percentile(50),
                    "min": sorted_times[0],
                    "max": sorted_times[-1],
                    "p95": percentile(95),
                    "p99": percentile(99),
                    "std": variance**0.5,
                },
                "counts": {"success": self.success_count, "failed": self.fail_count},
                "errors": dict(self.errors),
            }

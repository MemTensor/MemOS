# Independent scheduler workers

A Scheduler, its executor, database connections, locks and local queue belong to
the process that constructed them. `scheduler_startup_mode="process"` no longer
forks an existing Scheduler: it raises a configuration error. The default thread
mode is unchanged. Lifecycle operations on an instance inherited through `fork`
also fail before acquiring its locks.

To run a separate worker, construct and configure the Scheduler **inside that
worker**. The application chooses the process context and owns supervision:

```python
import multiprocessing

from memos.mem_scheduler.worker import run_scheduler_worker
from my_agent.runtime import build_scheduler, run_application

if __name__ == "__main__":
    context = multiprocessing.get_context("spawn")
    stop = context.Event()
    worker = context.Process(target=run_scheduler_worker, args=(build_scheduler, stop))
    worker.start()
    try:
        # Run the application's producers; submit data through Redis.
        run_application()
    finally:
        stop.set()
        worker.join()
        if worker.exitcode != 0:
            raise ChildProcessError("Memory worker failed")
        worker.close()
```

`build_scheduler` above is an application-owned, importable factory, not a MemOS
function. It must return a fully configured Scheduler using thread startup mode,
with its modules, Cube, Feedback and handlers assembled in the child. Create
connections there, too. Do not capture an existing Scheduler or connection in the
factory. If initialization fails before returning, the factory must close its
partially created resources. After it returns, `run_scheduler_worker` guarantees
`close()` on normal stop and on startup/runtime failure.

Use a shared Redis queue for producers in another process. An ordinary local
queue is only available within its worker. The existing Redis stream discovery
cycle is 30 seconds, so a newly created stream may not be consumed immediately.
The stop signal stops consuming new
work; `close()` drains accepted executor tasks before releasing owned components.
Queued Redis messages may remain for another worker. This is not a guarantee of
exactly-once processing. A forced process kill bypasses cooperative cleanup and
must not be interpreted as successful task completion.

Injected Cubes, Feedback servers and their dependencies remain owned by the
application. The factory must arrange their cleanup after the Scheduler drains,
or use the Scheduler's existing internally owned component initialization. A
missing Feedback server can be assembled from a borrowed Cube's dependencies;
incomplete dependencies raise `ConfigurationError` rather than selecting a
different default Cube.

# Feedback outcomes

Synchronous Feedback returns `answer`, `record`, and `answer_status`:

| answer_status | Meaning |
| --- | --- |
| `not_requested` | `corrected_answer` was false; no answer generation was requested |
| `generated` | A nonblank answer was generated |
| `unavailable` | Optional answer generation failed or returned no usable text |

For `not_requested` and `unavailable`, `answer` is an empty placeholder, not text
to display to a user. An agent or application can retain its previous answer or
present its own localized message. A successful `record` is preserved even when
the answer is unavailable. Core memory errors propagate to SDK callers; HTTP
feedback endpoints return a stable failure response without driver diagnostics.

Async feedback success means submission was accepted, not that memory processing
has finished. Consumers must use task status to observe completion or failure.
Failed feedback does not fall back to ordinary memory addition. Multi-Cube
synchronous results retain each complete result object in Cube order. Writes
across steps or Cubes are not one transaction; do not blindly retry an operation
whose commit outcome is uncertain.

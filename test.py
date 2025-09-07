import os

def generate_trace_id() -> str:
    """Generate a random trace_id."""
    return os.urandom(16).hex()


print(generate_trace_id())
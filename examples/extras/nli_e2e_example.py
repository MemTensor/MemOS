import sys
import threading
import time

import requests
import uvicorn

from memos.extras.nli_model.client import NLIClient
from memos.extras.nli_model.server.serve import app


# Config
PORT = 32534


def run_server():
    print(f"Starting server on port {PORT}...")
    # Using a separate thread for the server
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


def main():
    print("Initializing E2E Test...")

    # Start server thread
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # Wait for server to be up
    print("Waiting for server to initialize (this may take time if downloading model)...")
    client = NLIClient(base_url=f"http://127.0.0.1:{PORT}")

    # Poll until server is ready
    start_time = time.time()
    ready = False

    # Wait up to 5 minutes for model download and initialization
    timeout = 300

    while time.time() - start_time < timeout:
        try:
            # Check if docs endpoint is accessible
            resp = requests.get(f"http://127.0.0.1:{PORT}/docs", timeout=1)
            if resp.status_code == 200:
                ready = True
                break
        except requests.ConnectionError:
            pass
        except Exception:
            # Ignore other errors during startup
            pass

        time.sleep(2)
        print(".", end="", flush=True)

    print("\n")
    if not ready:
        print("Server failed to start in time.")
        sys.exit(1)

    print("Server is up! Sending request...")

    # Test Data
    source = "I like apples"
    targets = ["I like apples", "I hate apples", "Paris is a city"]

    try:
        results = client.compare_one_to_many(source, targets)
        print("-" * 30)
        print(f"Source: {source}")
        print("Targets & Results:")
        for t, r in zip(targets, results, strict=False):
            print(f"  - '{t}': {r.value}")
        print("-" * 30)

        # Basic Validation
        passed = True
        if results[0].value != "Duplicate":
            print(f"FAILURE: Expected Duplicate for '{targets[0]}', got {results[0].value}")
            passed = False

        if results[1].value != "Contradiction":
            print(f"FAILURE: Expected Contradiction for '{targets[1]}', got {results[1].value}")
            passed = False

        if results[2].value != "Unrelated":
            print(f"FAILURE: Expected Unrelated for '{targets[2]}', got {results[2].value}")
            passed = False

        if passed:
            print("\nSUCCESS: Logic verification passed!")
        else:
            print("\nFAILURE: Unexpected results!")

    except Exception as e:
        print(f"Error during request: {e}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nTest interrupted.")

import random
import threading
import time


class ThreadRace:
    def __init__(self):
        # Variable to store the result
        self.result = None
        # Event to mark if the race is finished
        self.race_finished = threading.Event()
        # Lock to protect the result variable
        self.lock = threading.Lock()
        # Store thread objects for termination
        self.threads = {}
        # Stop flags for each thread
        self.stop_flags = {}

    def task1(self, stop_flag):
        """First task function, can be modified as needed"""
        # Simulate random work time
        sleep_time = random.uniform(0.1, 2.0)

        # Break the sleep into smaller chunks to check stop flag
        chunks = 20
        chunk_time = sleep_time / chunks

        for _ in range(chunks):
            # Check if we should stop
            if stop_flag.is_set():
                return None
            time.sleep(chunk_time)

        return f"Task 1 completed in: {sleep_time:.2f} seconds"

    def task2(self, stop_flag):
        """Second task function, can be modified as needed"""
        # Simulate random work time
        sleep_time = random.uniform(0.1, 2.0)

        # Break the sleep into smaller chunks to check stop flag
        chunks = 20
        chunk_time = sleep_time / chunks

        for _ in range(chunks):
            # Check if we should stop
            if stop_flag.is_set():
                return None
            time.sleep(chunk_time)

        return f"Task 2 completed in: {sleep_time:.2f} seconds"

    def worker(self, task_func, task_name):
        """Worker thread function"""
        # Create a stop flag for this task
        stop_flag = threading.Event()
        self.stop_flags[task_name] = stop_flag

        try:
            # Execute the task with stop flag
            result = task_func(stop_flag)

            # If the race is already finished or we were asked to stop, return immediately
            if self.race_finished.is_set() or stop_flag.is_set():
                return None

            # Try to set the result (if no other thread has set it yet)
            with self.lock:
                if not self.race_finished.is_set():
                    self.result = (task_name, result)
                    # Mark the race as finished
                    self.race_finished.set()
                    print(f"{task_name} won the race!")

                    # Signal other threads to stop
                    for name, flag in self.stop_flags.items():
                        if name != task_name:
                            print(f"Signaling {name} to stop")
                            flag.set()

                    return self.result

        except Exception as e:
            print(f"{task_name} encountered an error: {e}")

        return None

    def run_race(self):
        """Start the competition and return the result of the fastest thread"""
        # Reset state
        self.race_finished.clear()
        self.result = None
        self.threads.clear()
        self.stop_flags.clear()

        # Create threads
        thread1 = threading.Thread(target=self.worker, args=(self.task1, "Thread 1"))
        thread2 = threading.Thread(target=self.worker, args=(self.task2, "Thread 2"))

        # Record thread objects for later joining
        self.threads["Thread 1"] = thread1
        self.threads["Thread 2"] = thread2

        # Start threads
        thread1.start()
        thread2.start()

        # Wait for any thread to complete
        while not self.race_finished.is_set():
            time.sleep(0.01)  # Small delay to avoid high CPU usage

            # If all threads have ended but no result is set, there's a problem
            if (
                not thread1.is_alive()
                and not thread2.is_alive()
                and not self.race_finished.is_set()
            ):
                print("All threads have ended, but there's no winner")
                return None

        # Wait for all threads to end (with timeout to avoid infinite waiting)
        thread1.join(timeout=1.0)
        thread2.join(timeout=1.0)

        # Return the result
        return self.result


# Usage example
if __name__ == "__main__":
    race = ThreadRace()
    result = race.run_race()
    print(f"Winner: {result[0] if result else None}")
    print(f"Result: {result[1] if result else None}")

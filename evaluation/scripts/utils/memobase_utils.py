import time
import uuid

from memobase import ChatBlob


def string_to_uuid(s: str, salt="memobase_client") -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, s + salt))


def memobase_add_memory(user, message, retries=3):
    for attempt in range(retries):
        try:
            _ = user.insert(ChatBlob(messages=message), sync=True)
            return
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1)
                continue
            else:
                raise e


def memobase_search_memory(
    client, user_id, query, max_memory_context_size, max_retries=3, retry_delay=1
):
    retries = 0
    real_uid = string_to_uuid(user_id)
    u = client.get_user(real_uid, no_get=True)

    while retries < max_retries:
        try:
            memories = u.context(
                max_token_size=max_memory_context_size,
                chats=[{"role": "user", "content": query}],
                event_similarity_threshold=0.2,
                fill_window_with_events=True,
            )
            return memories
        except Exception as e:
            print(f"Error during memory search: {e}")
            print("Retrying...")
            retries += 1
            if retries >= max_retries:
                raise e
            time.sleep(retry_delay)


if __name__ == "__main__":
    from memobase import MemoBaseClient, ChatBlob

    client = MemoBaseClient(
        project_url='http://106.15.45.221:8019',
        api_key='secret',
    )
    client.ping()
    uid = client.add_user({"name": "Gustavo"})
    b = ChatBlob(messages=[
        {"role": "user", "content": "Hi, I like apple very much!"}
    ])
    u = client.get_user(uid)
    bid = u.insert(b)

    u.flush()  # async
    u.flush(sync=True)  # sync

    u.context()



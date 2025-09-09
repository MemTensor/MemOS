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

    users = client.get_all_users(limit=5000)
    for u in users:
        try:
            if u['additional_fields']['user_id'] == user_id:
                user = client.get_user(u['id'], no_get=True)
        except:
            pass

    retries = 0

    while retries < max_retries:
        try:
            memories = user.context(
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
        project_url='http://47.117.45.189:8019',
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





    memories = user.context(
        max_token_size=2000,
        chats=[{"role": "user", "content": 'hello'}],
        event_similarity_threshold=0.2,
        fill_window_with_events=True,
    )
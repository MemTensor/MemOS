from memos.types import MessageList


def convert_messages_to_string(messages: MessageList) -> str:
    """Convert a list of messages to a string."""
    message_text = ""
    for message in messages:
        if message["role"] == "user":
            message_text += f"Query: {message['content']}\n" if message["content"].strip() else ""
        elif message["role"] == "assistant":
            message_text += f"Answer: {message['content']}\n" if message["content"].strip() else ""
    message_text = message_text.strip()
    return message_text

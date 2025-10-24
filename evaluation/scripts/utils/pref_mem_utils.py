

def create_mem_string(relevant_memories) -> str:
    text_memories = []
    explicit = []
    implicit = []
    for item in relevant_memories["text_mem"]:
        for mem in item["memories"]:
            text_memories.append(mem['memory'])
    text_context = ""
    if text_memories:
        text_memories_text = '\n'.join(text_memories)
        text_context += f"Plaintext Memory:\n{text_memories_text}\n"
    for item in relevant_memories["pref_mem"]:
        for mem in item["memories"]:
            if mem["metadata"]["preference_type"] == "explicit_preference":
                explicit.append(mem["metadata"]["explicit_preference"])
            elif mem["metadata"]["preference_type"] == "implicit_preference":
                implicit.append(mem["metadata"]["implicit_preference"])
    pref_context = ""
    if explicit:
        explicit_text = '\n'.join(explicit)
        pref_context += f"Explicit Preference:\n{explicit_text}\n"
    if implicit:
        implicit_text = '\n'.join(implicit)
        pref_context += f"Implicit Preference:\n{implicit_text}\n"
    context = ""
    if text_memories and explicit and implicit:
        context = f"{text_context}\n{pref_context}"
    return context


def remove_pref_mem_from_mem_string(mem_string: str) -> str:
    tmp_list = mem_string.split("Plaintext Memory:")
    if len(tmp_list) > 1:
        return tmp_list[1].split("Explicit Preference:")[0]
    else:
        return mem_string


if __name__ == "__main__":
    mem_string = "Plaintext Memory:\nadsadsasasadsadsadsadsa\nExplicit Preference:\nThis is an explicit preference\nImplicit Preference:\nThis is an implicit preference\n"
    print(remove_pref_mem_from_mem_string(mem_string))
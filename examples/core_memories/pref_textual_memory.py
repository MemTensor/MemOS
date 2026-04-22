import time

from memos import log
from memos.configs.memory import PreferenceTextMemoryConfig
from memos.memories.textual.preference import PreferenceTextMemory


logger = log.get_logger(__name__)

preference_config = PreferenceTextMemoryConfig.from_json_file(
    "examples/data/config/preference_config.json"
)
my_preference_textual_memory = PreferenceTextMemory(preference_config)
my_preference_textual_memory.delete_all()


scene_data = [
    [
        {"role": "user", "chat_time": "3 May 2025", "content": "I’m feeling a bit down today."},
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "I’m sorry to hear that. Do you want to talk about what’s been going on?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "It’s just been a tough couple of days, you know? Everything feels a bit overwhelming, and I just can’t seem to shake it off.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "It sounds like you're going through a lot right now. Sometimes it helps to talk things out. Is there something specific that's been weighing on you, or is it more of a general feeling?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "It’s a mix, I guess. Work’s been really stressful, and on top of that, I’ve been feeling kinda disconnected from the people around me.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "That can be really draining, especially when you’re feeling isolated on top of the stress. Do you think there’s something from your past that’s contributing to how you’re feeling now? Sometimes our emotions are tied to older experiences.",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "Yeah, now that you mention it… I’ve been thinking a lot about my childhood lately. I didn’t have the easiest upbringing. My parents were always busy, and I often felt like I had to figure things out on my own. I remember one winter, I got really sick with a high fever. My parents were both working, and I didn’t want to bother them. I just lay in bed, crying by myself, not knowing what to do.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "That must have been very lonely. Growing up without that support can really make you feel like you have to handle everything on your own. How do you think that experience has affected you now?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "Yeah, it was really lonely. I remember spending a lot of time doing things on my own, like drawing, because it was my only way to escape. I used to draw animals, and I created my own little world on paper. It was peaceful in a way, just me and my imagination, with no outside distractions.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "Drawing sounds like a beautiful way to express yourself and find some peace in that solitude. It must have been a very quiet and private world for you. Do you think that sense of loneliness from back then has shaped how you connect with others today?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I think it has. I’ve always found it hard to let others in. I feel like I have to handle everything on my own. If I rely on someone else, I feel vulnerable, and I start to feel that loneliness again.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "It sounds like this was a protective mechanism that helped you cope with your feelings of loneliness back then. But as you’ve grown, it seems like this pattern might not be serving you as well anymore. Have you thought about trying to break this cycle, or finding new ways to connect with others?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I’ve thought about it, though it’s hard. But I also know I can’t keep going like this forever. Maybe it’s time to seek some help.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "It’s a big step, but a positive one. Exploring your emotions and past experiences could really help you understand how they’ve shaped your present. Therapy could be a great place to start, as it would help you connect with both yourself and others. Would you be open to trying it?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I’m open to trying. Thank you for encouraging me. It feels like it might be a good starting point for me.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "I’m really glad to hear that. Taking that first step is always difficult, but you’ve made an important decision. If you need help finding the right therapist, or just want to talk, I’m here for you.",
        },
    ],
    [
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "This week I’ve been feeling a bit off, especially when playing tennis. My body just doesn’t feel right.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "It sounds like you've been having some physical discomfort lately. Where specifically are you feeling unwell? Is there something particular about tennis that's been difficult?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I just feel a bit fatigued, and every time I play tennis, my movements feel off. I used to play pretty well, but lately, I’ve been feeling weak and my movements aren’t as coordinated as they used to be.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "Physical discomfort can definitely affect performance, especially in a sport like tennis that requires quick reactions and coordination. Have you noticed anything specific that might be causing these changes? Could it be overtraining, or is there another physical issue making you feel off?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I think it might be due to stress and lack of sleep recently. I just feel drained all the time. Plus, I’ve been frustrated with my tennis performance, which makes me feel even worse, like I’m stuck in a vicious cycle.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "Stress and poor sleep quality can definitely affect your physical performance, especially in sports. When you’re also feeling down about your performance, it’s easy to fall into a negative cycle. Have you tried anything to relieve some of the stress, or to improve your sleep?",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "I’ve tried some relaxation techniques, like deep breathing and simple meditation, but it doesn’t seem to help much. I still can’t focus during tennis, and I feel like my mind is distracted by other things.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "Relaxation techniques like deep breathing and meditation can help reduce stress, but sometimes we need a more structured approach to improve both our physical and mental state. For example, you might want to focus on specific aspects of your tennis training, or adjust your rest and recovery time. Have you thought about setting smaller goals for yourself? Like focusing on a specific tennis move each day, rather than expecting perfection right away? That might help you gradually regain confidence.",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "That’s a good idea. I think I’ve been expecting too much from myself, which just makes me more anxious. Maybe I can start with small practice sessions and gradually find my rhythm again.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "Exactly! Setting small and clear goals will help reduce pressure and give you a sense of accomplishment. And don’t forget that rest is just as important—taking time to recover will help you feel better physically and mentally. Both physical and mental recovery are key to improving your performance and health.",
        },
        {
            "role": "user",
            "chat_time": "3 May 2025",
            "content": "Thanks, I feel like I need to rethink a few things. Maybe I really need to be kinder to myself and take things step by step.",
        },
        {
            "role": "assistant",
            "chat_time": "3 May 2025",
            "content": "You’re on the right track. Rethinking things and giving yourself space and patience is so important. You’ve already taken the first step, now just keep moving forward, one step at a time. If you need anything, I’m always here to help.",
        },
    ],
]

memories = my_preference_textual_memory.get_memory(
    scene_data, type="chat", info={"user_id": "1234", "session_id": "2222"}
)

added_ids = my_preference_textual_memory.add(memories)

time.sleep(10)

init_time = time.time()
# search preference memories
results = my_preference_textual_memory.search("Talk about childhood story of the user", top_k=10)

for i, r in enumerate(results):
    r = r.to_dict()
    print(f"{i}'th similar result is: " + str(r["memory"]))
print(f"Successfully search {len(results)} memories in {round(time.time() - init_time)}s")

# get all preference memories
all_preference_memories = my_preference_textual_memory.get_all()
for key, value in all_preference_memories.items():
    for i, m in enumerate(value):
        print(f"{i}'th {key} memory is: " + str(m.memory))

# use filter to get all implicit preference memories
all_implicit_memories = my_preference_textual_memory.get_memory_by_filter(
    {"preference_type": "implicit_preference"}
)
for i, m in enumerate(all_implicit_memories[0]):
    print(f"{i}'th filtered memory is: " + str(m.memory))

# dump preference memories
dumped_memories_dir = "tmp/my_preference_textual_memory"
my_preference_textual_memory.dump(dumped_memories_dir)

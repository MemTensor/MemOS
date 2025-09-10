import json
import time
import pandas as pd
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.mirix_utils import get_mirix_client
from tqdm import tqdm

if __name__ == '__main__':
    config_path = './configs/mirix_config.yaml'
    lme_df = pd.read_json("./data/longmemeval/longmemeval_s.json")
    f = open("./results/lme/mirix_lme_test_result.json", "w+")

    assistant = get_mirix_client(config_path)

    # for index in range(len(lme_df)):
    for index in range(0, 5):
        conversation = lme_df.iloc[index]
        sessions = conversation["haystack_sessions"]
        dates = conversation["haystack_dates"]
        q = conversation['question']
        a = conversation['answer']
        q_date = conversation['question_date']
        q_type = conversation['question_type']
        for session, date in tqdm(zip(sessions, dates)):
            if session:
                t = time.time()
                message = f"Conversation happened at {date}:\n\n"
                for turn in session:
                    message += turn['role'] + ": " + turn['content']
                    message += "\n"
                assistant.add(message)
                print(f"add one session time: {time.time() - t}")

        assistant._agent.update_core_memory_persona(
            "Is a helpful assistant that answers questions with extreme conciseness.\nIs persistent and tries to "
            "find the answerr using different queries and different search methods. Never uses unnecessary words "
            "or repeats the question in the answer. Always provides the shortest answer possible and tries to "
            "utter the fewest words possible.")

        assistant.save(f'./results/lme/mirix_lme_test_{index}')

        response = assistant.chat(f"Current Date: {q_date}\n\n{q}")
        res = conversation.to_dict()
        res['response'] = response
        res['index'] = index

        f.write(json.dumps(res, ensure_ascii=False) + "\n")
        f.flush()









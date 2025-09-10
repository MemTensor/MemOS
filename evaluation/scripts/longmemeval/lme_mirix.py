import concurrent
import json
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
import pandas as pd
from tqdm import tqdm
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.mirix_utils import get_mirix_client


if __name__ == '__main__':
    config_path = './configs/mirix_config.yaml'
    lme_df = pd.read_json("./data/longmemeval/longmemeval_s.json")
    assistant = get_mirix_client(config_path)

    def process_one(index):
        conversation = lme_df.iloc[index]
        sessions = conversation["haystack_sessions"]
        dates = conversation["haystack_dates"]
        q = conversation['question']
        a = conversation['answer']
        q_date = conversation['question_date']
        q_type = conversation['question_type']
        assistant.create_user(user_name=f"lme_user_{index}")
        user = assistant.get_user_by_name(user_name=f"lme_user_{index}")

        for session, date in tqdm(zip(sessions, dates)):
            if session:
                t = time.time()
                message = f"Conversation happened at {date}:\n\n"
                for turn in session:
                    message += turn['role'] + ": " + turn['content']
                    message += "\n"
                assistant.add(message, user_id=user.id)
                print(f"add one session time: {time.time() - t}")

        assistant._agent.update_core_memory_persona(
            "Is a helpful assistant that answers questions with extreme conciseness.\nIs persistent and tries to find "
            "the answerr using different queries and different search methods. Never uses unnecessary words or repeats "
            "the question in the answer. Always provides the shortest answer possible and tries to utter the fewest words possible.")

        response = assistant.chat(f"Current Date: {q_date}\n\n{q}", user_id=user.id)
        res = conversation.to_dict()
        res['response'] = response
        res['index'] = index
        return res

    f = open("./results/lme/mirix_lme_test_result.json", "w+")

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        total = len(lme_df)
        futures = []
        for i in range(len(lme_df)):
            future = executor.submit(process_one, i)
            futures.append(future)

        for future in tqdm(concurrent.futures.as_completed(futures), total=total, desc="Processing Conversations"):
            try:
                result = future.result()
                f.write(json.dumps(result, ensure_ascii=False) + "\n")
                f.flush()
            except Exception as exc:
                traceback.print_exc()
                print(f"❌ Error processing {exc}")

    assistant.save(f'./results/lme/mirix_lme_test')




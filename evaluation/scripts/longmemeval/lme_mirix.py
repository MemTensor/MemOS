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
    success_results = []
    success_idx = []

    if os.path.exists('./results/lme/mirix_lme_test_result.json'):
        results = [json.loads(i) for i in open("./results/lme/mirix_lme_test_result.json", 'r').readlines()]
        for res in results:
            with open("./results/lme/mirix_lme_test_result.json", "w") as f:
                if res['response'] and "ERROR" not in res['response']:
                    f.write(json.dumps(res, ensure_ascii=False) + "\n")
                    success_idx.append(res['index'])

    f = open("./results/lme/mirix_lme_test_result.json", "a+")


    def process_one(index):
        assistant = get_mirix_client(config_path)
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

        response = assistant.chat(f"""You will be given a question and you need to answer the question based on the memories.
    # APPROACH (Think step by step):
    1. First, search and check the memories that might contain information related to the question.
    2. Examine the timestamps and content of these memories carefully.
    3. Look for explicit mentions of dates, times, locations, or events that answer the question.
    4. If the answer requires calculation (e.g., converting relative time references), show your work.
    5. Formulate a precise, concise answer based solely on the evidence in the memories.
    6. Double-check that your answer directly addresses the question asked.
    7. Ensure your final answer is specific and avoids vague time references like "yesterday", "last year" but with specific dates.
    8. The answer should be as brief as possible, you should **only state the answer** WITHOUT repeating the question. For example, if asked 'When did Mary go to the store?', you should simply answer 'June 1st'. Do NOT say 'Mary went to the store on June 1st' which is redundant and strictly forbidden. Your answer should be as short as possible.
    Current Date: {q_date}
    Question: {q}""", user_id=user.id)
        res = conversation.to_dict()
        res['response'] = response
        res['index'] = index
        assistant.save(f'./results/lme/mirix_lme_test_{index}')
        return res


    for i in tqdm(range(len(lme_df))):
        if i not in success_idx:
            try:
                res = process_one(i)
                f.write(json.dumps(res, ensure_ascii=False) + "\n")
                f.flush()
            except Exception as exc:
                traceback.print_exc()
                print(f"❌ Error processing {exc}")







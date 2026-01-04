import os

from pathlib import Path

import openai

from dotenv import load_dotenv


load_dotenv()

client = openai.Client(
    api_key=os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    base_url=os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
)

PROMPT_PATH = Path("evaluation/scripts/utils/prompt_for_answer_extraction.md")
with open(PROMPT_PATH, encoding="utf-8") as f:
    EXTRACTION_PROMPT = f.read()


def extract_answer(question: str, output: str, model_name: str = "gpt-4o-mini") -> str:
    resp = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "user", "content": EXTRACTION_PROMPT},
            {"role": "assistant", "content": f"\n\nQuestion:{question}\nAnalysis:{output}\n"},
        ],
        temperature=0.0,
        max_tokens=256,
        top_p=1,
        frequency_penalty=0,
        presence_penalty=0,
    )
    content = resp.choices[0].message.content or ""
    return content


def parse_extracted_answer(extracted_res: str, fallback_output: str) -> str:
    try:
        head = extracted_res.split("Answer format:")[0]
        ans = head.split("Extracted answer:")[1].strip()
        if ans:
            return ans
    except Exception:
        pass
    text = (fallback_output or "").strip()
    low = text.lower()
    if " yes" in low or low.startswith("yes"):
        return "yes"
    if " no" in low or low.startswith("no"):
        return "no"
    for sep in ["\n", ". ", ".", "?", "!"]:
        if sep in text:
            cand = text.split(sep)[0].strip()
            if cand:
                return cand
    return text

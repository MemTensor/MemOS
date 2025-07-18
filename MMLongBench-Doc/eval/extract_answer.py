import os

import openai


client = openai.Client(
    api_key=os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    base_url=os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
)


def extract_answer(question, output, prompt, model_name="gpt-4o"):
    response = client.chat.completions.create(
        model=model_name,
        messages=[
            {
                "role": "user",
                "content": prompt,
            },
            {"role": "assistant", "content": f"\n\nQuestion:{question}\nAnalysis:{output}\n"},
        ],
        temperature=0.0,
        max_tokens=256,
        top_p=1,
        frequency_penalty=0,
        presence_penalty=0,
    )
    response = response.choices[0].message.content

    return response

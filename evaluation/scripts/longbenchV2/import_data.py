from datasets import load_dataset


dataset = load_dataset("zai-org/LongBench-v2", split="train")
print(dataset)


def truncate(value, max_len=200):
    if isinstance(value, str) and len(value) > max_len:
        return value[:max_len] + "... [TRUNCATED]"
    return value


for i in range(10):
    sample = dataset[i]
    print(f"========== Sample {i} ==========")
    for key, value in sample.items():
        print(f"{key}: {truncate(value)}")

    print("\n")

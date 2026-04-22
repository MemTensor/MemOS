import json
import os

from datasets import load_dataset


def convert_dataset_to_jsonl(dataset_name, output_dir="./scripts/PrefEval"):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    try:
        dataset = load_dataset(dataset_name)
    except Exception as e:
        print(f"Error loading dataset: {e}")
        return False

    for split_name, split_data in dataset.items():
        output_file_path = os.path.join(output_dir, f"{split_name}.jsonl")
        try:
            split_data.to_json(output_file_path, orient="records", lines=True)
            print(f"Successfully saved the '{split_name}' split to {output_file_path}")
        except Exception as e:
            print(f"Error saving split '{split_name}' to JSONL: {e}")
            return False

    return True


def restructure_conversation_in_json(data):
    if "conversation" not in data:
        return data

    conversation_dict = data["conversation"]
    conversation_list = []

    try:
        sorted_turn_keys = sorted(conversation_dict.keys(), key=int)
    except (ValueError, TypeError):
        sorted_turn_keys = sorted(conversation_dict.keys())

    for key in sorted_turn_keys:
        turn_data = conversation_dict.get(key)
        if (
            turn_data
            and isinstance(turn_data, dict)
            and "user" in turn_data
            and "assistant" in turn_data
        ):
            user_text = turn_data["user"]
            assistant_text = turn_data["assistant"]

            conversation_list.append({"role": "user", "content": user_text})
            conversation_list.append({"role": "assistant", "content": assistant_text})

    result_data = data.copy()
    if "conversation" in result_data:
        del result_data["conversation"]
    result_data["conversation"] = conversation_list

    return result_data


def process_jsonl_file(input_filepath, output_filepath):
    try:
        line_count = 0
        print(f"Start processing file: {input_filepath}")
        with (
            open(input_filepath, encoding="utf-8") as infile,
            open(output_filepath, "w", encoding="utf-8") as outfile,
        ):
            for line in infile:
                if not line.strip():
                    continue
                try:
                    original_data = json.loads(line)
                    processed_data = restructure_conversation_in_json(original_data)
                    outfile.write(json.dumps(processed_data, ensure_ascii=False) + "\n")
                    line_count += 1
                    if line_count % 1000 == 0:
                        print(f"Processed {line_count} lines...")
                except json.JSONDecodeError:
                    print(f"Warning: Skipping malformed line: {line.strip()}")
        print(f"\nProcessing completed! Total processed lines: {line_count}.")
        print(f"Result saved to: {output_filepath}")
        return True
    except FileNotFoundError:
        print(f"Error: Input file not found: {input_filepath}")
        return False
    except Exception as e:
        print(f"Unknown error occurred: {e}")
        return False


def main():
    huggingface_dataset_name = "siyanzhao/prefeval_implicit_persona"
    output_directory = "./data/prefeval"
    os.makedirs(output_directory, exist_ok=True)
    input_file_path = os.path.join(output_directory, "train.jsonl")
    processed_file_path = os.path.join(output_directory, "pref_processed.jsonl")

    if convert_dataset_to_jsonl(huggingface_dataset_name, output_directory):
        print("Dataset download and conversion completed!")
    else:
        print("Dataset download and conversion failed, please check error messages.")
        return

    if not os.path.exists(input_file_path):
        print(f"Error: Input file '{input_file_path}' does not exist.")
        return

    if process_jsonl_file(input_file_path, processed_file_path):
        print("Conversation format processing completed!")
    else:
        print("Conversation format processing failed, please check error messages.")
        return


if __name__ == "__main__":
    main()

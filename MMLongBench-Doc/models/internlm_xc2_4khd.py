import torch
import torch.nn.functional as F

from transformers import AutoModel, AutoTokenizer


torch.set_grad_enabled(False)


try:
    from transformers.generation.streamers import BaseStreamer
except:  # noqa # pylint: disable=bare-except
    BaseStreamer = None


def chat(
    model,
    tokenizer,
    query: str,
    image: None,
    hd_num: int = 25,
    history: list[tuple[str, str]] = [],
    streamer: BaseStreamer | None = None,
    max_new_tokens: int = 1024,
    temperature: float = 1.0,
    top_p: float = 0.8,
    repetition_penalty: float = 1.005,
    meta_instruction: str = "You are an AI assistant whose name is InternLM-XComposer (浦语·灵笔).\n"
    "- InternLM-XComposer (浦语·灵笔) is a multi-modality conversational language model that is developed by Shanghai AI Laboratory (上海人工智能实验室). It is designed to be helpful, honest, and harmless.\n"
    "- InternLM-XComposer (浦语·灵笔) can understand and communicate fluently in the language chosen by the user such as English and 中文.\n"
    "- InternLM-XComposer (浦语·灵笔) is capable of comprehending and articulating responses effectively based on the provided image.",
    **kwargs,
):
    if image is None:
        inputs = model.build_inputs(tokenizer, query, history, meta_instruction)
        im_mask = torch.zeros(inputs["input_ids"].shape[:2]).cuda().bool()
    else:
        if type(image) == str:
            with torch.cuda.amp.autocast():
                image = model.encode_img(image, hd_num=hd_num)
            inputs, im_mask = model.interleav_wrap_chat(
                tokenizer, query, image, history, meta_instruction
            )
        elif type(image) == list:
            image_list = []
            with torch.cuda.amp.autocast():
                for image_path in image:
                    tmp = model.encode_img(image_path, hd_num=hd_num)
                    image_list.append(tmp)
            if len(image_list) > 1 and image_list[-1].shape[1] != image_list[-2].shape[1]:
                image_list[-1] = F.interpolate(
                    image_list[-1].unsqueeze(1), size=image_list[-2].shape[1:], mode="bilinear"
                ).squeeze(1)
            image = torch.cat(image_list, dim=0)
            with torch.cuda.amp.autocast():
                inputs, im_mask = model.interleav_wrap_chat(
                    tokenizer, query, image, history, meta_instruction
                )
        else:
            raise NotImplementedError
    inputs = {k: v.to(model.device) for k, v in inputs.items() if torch.is_tensor(v)}
    # also add end-of-assistant token in eos token id to avoid unnecessary generation
    eos_token_id = [
        tokenizer.eos_token_id,
        tokenizer.convert_tokens_to_ids(["[UNUSED_TOKEN_145]"])[0],
    ]
    # print(inputs['inputs_embeds'].shape[1])
    with torch.cuda.amp.autocast():
        outputs = model.generate(
            **inputs,
            streamer=streamer,
            max_new_tokens=max_new_tokens,
            do_sample=False if temperature == 0.0 else True,
            temperature=temperature,
            top_p=top_p,
            eos_token_id=eos_token_id,
            repetition_penalty=repetition_penalty,
            im_mask=im_mask,
            **kwargs,
        )
    if image is None:
        outputs = outputs[0].cpu().tolist()[len(inputs["input_ids"][0]) :]
    else:
        outputs = outputs[0].cpu().tolist()
    response = tokenizer.decode(outputs, skip_special_tokens=True)
    response = response.split("[UNUSED_TOKEN_145]")[0]
    history = history + [(query, response)]
    return response, history


def init_model(cache_path):
    model_path = (
        cache_path
        if (cache_path is not None and cache_path != "None")
        else "internlm/internlm-xcomposer2-4khd-7b"
    )
    model = AutoModel.from_pretrained(
        model_path,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
        trust_remote_code=True,
        device_map="auto",
    ).eval()

    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    model.tokenizer = tokenizer
    return model


def get_response_concat(model, question, image_path_list, max_new_tokens=1024, temperature=1.0):
    query = "<ImageHere> " * len(image_path_list) + question
    try:
        response, _ = chat(
            model,
            model.tokenizer,
            query=query,
            image=image_path_list,
            max_new_tokens=max_new_tokens,
            hd_num=16,
            temperature=temperature,
        )
    except Exception as e:
        print(e)
        response = "Failed"
    return response

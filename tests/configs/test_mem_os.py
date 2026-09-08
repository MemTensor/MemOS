from memos.configs.mem_os import MOSConfig


def test_mos_config_generates_unique_default_session_ids():
    first_config = MOSConfig.model_construct(chat_model=None, mem_reader=None)
    second_config = MOSConfig.model_construct(chat_model=None, mem_reader=None)

    assert first_config.session_id != second_config.session_id

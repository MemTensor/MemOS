from unittest.mock import patch

from memos.hello_world import (
    memos_chend_hello_world,
    memos_chentang_hello_world,
    memos_dany_hello_world,
    memos_hello_world,
    memos_huojh_hello_world,
    memos_niusm_hello_world,
    memos_wanghy_hello_world,
    memos_wangyzh_hello_world,
    memos_yuqingchen_hello_world,
    memos_zhaojihao_hello_world,
)


def test_memos_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_hello_world()

        assert result == "Hello world from memos!"
        mock_logger.assert_called_once_with("memos_hello_world function called.")


def test_memos_dany_hello_world_logger_called():
    """# What's patch for?
    Using path, we can mock a function that is called in the function we are testing.

    > For example, a new function A called function B, and function B will take a long time to run.
    > So testing function A will take a long time.
    > Using path, we can pmock a return value from B, so that we can test function A faster.
    """
    # Multiple test cases example:
    test_cases = [
        (1, "data1", "logger.info: para_1 is 1", "logger.debug: para_2 is data1", "return_value_1"),
        (2, "data2", "logger.info: para_1 is 2", "logger.debug: para_2 is data2", "return_value_2"),
        (3, "data3", "logger.info: para_1 is 3", "logger.debug: para_2 is data3", "return_value_3"),
    ]
    with (
        patch("memos.hello_world.logger.info") as mock_logger_info,
        patch("memos.hello_world.logger.debug") as mock_logger_debug,
    ):
        for para1, para2, expected_output_1, expected_output_2, expected_return_value in test_cases:
            result = memos_dany_hello_world(para1, para2)

            assert result == expected_return_value
            mock_logger_info.assert_any_call(expected_output_1)
            mock_logger_debug.assert_called_once_with(expected_output_2)

            mock_logger_info.reset_mock()
            mock_logger_debug.reset_mock()


def test_memos_chend_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos-chend!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_chend_hello_world()

        assert result == "Hello world from memos-chend!"
        mock_logger.assert_called_once_with("memos_chend_hello_world function called.")


def test_memos_wanghy_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos-wanghy!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_wanghy_hello_world()

        assert result == "Hello world from memos-wanghy!"
        mock_logger.assert_called_once_with("memos_wanghy_hello_world function called.")


def test_memos_huojh_hello_world_logger_called():
    """Test that the logger.info method is called and quicksort is okay."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        arr = [1, 7, 4, 1, 10, 9, -2]
        sorted_arr = [-2, 1, 1, 4, 7, 9, 10]
        res = memos_huojh_hello_world(arr)

        assert all(x == y for x, y in zip(sorted_arr, res, strict=False))
        mock_logger.assert_called_with("memos_huojh_hello_world function called.")


def test_memos_niusm_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos-niusm!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_niusm_hello_world()

        assert result == "Hello world from memos-niusm!"
        mock_logger.assert_called_once_with("memos_niusm_hello_world function called.")


def test_memos_wangyzh_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos-wangyzh!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_wangyzh_hello_world()

        assert result == "Hello world from memos-wangyzh!"
        mock_logger.assert_called_once_with("memos_wangyzh_hello_world function called.")


def test_memos_zhaojihao_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos-zhaojihao!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_zhaojihao_hello_world()

        assert result == "Hello world from memos-zhaojihao!"
        mock_logger.assert_called_once_with("memos_zhaojihao_hello_world function called.")


def test_memos_yuqingchen_hello_world_logger_called():
    """Test that the logger.info method is called and "Hello world from memos-yuqingchen!" is returned."""
    with patch("memos.hello_world.logger.info") as mock_logger:
        result = memos_yuqingchen_hello_world()

        assert result == "Hello world from memos-yuqingchen!"
        mock_logger.assert_called_once_with("memos_yuqingchen_hello_world function called.")


def test_memos_chen_tang_hello_world():
    import warnings

    from memos.memories.textual.general import GeneralTextMemory

    # Define return values for os.getenv
    def mock_getenv(key, default=None):
        mock_values = {
            "MODEL": "mock-model-name",
            "OPENAI_API_KEY": "mock-api-key",
            "OPENAI_BASE_URL": "mock-api-url",
            "EMBEDDING_MODEL": "mock-embedding-model",
        }
        return mock_values.get(key, default)

    # Filter Pydantic serialization warnings
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")
        # Use patch to mock os.getenv
        with patch("os.getenv", side_effect=mock_getenv):
            memory = memos_chentang_hello_world()
            assert isinstance(memory, GeneralTextMemory)

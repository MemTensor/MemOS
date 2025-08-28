import os
import sys
import unittest

from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory

from memos.configs.mem_scheduler import AuthConfig, GraphDBAuthConfig, OpenAIConfig, RabbitMQConfig
from memos.mem_scheduler.general_modules.misc import EnvConfigMixin
from memos.mem_scheduler.utils.config_utils import convert_config_to_env, flatten_dict


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

ENV_PREFIX = EnvConfigMixin.ENV_PREFIX


class TestEnvConfigMixin(unittest.TestCase):
    """Tests specifically for the EnvConfigMixin functionality"""

    def test_env_prefix_class_variable(self):
        """Verify the base environment prefix is set correctly"""
        self.assertEqual(EnvConfigMixin.ENV_PREFIX, "MEMSCHEDULER_")

    def test_get_env_prefix_generation(self):
        """Test the dynamic environment variable prefix generation"""
        # Test GraphDBAuthConfig specifically since it's causing issues
        self.assertEqual(
            GraphDBAuthConfig.get_env_prefix(),
            f"{ENV_PREFIX}GRAPHDBAUTH_",  # Critical: This is the correct prefix!
        )

        # Verify other configs
        self.assertEqual(RabbitMQConfig.get_env_prefix(), f"{ENV_PREFIX}RABBITMQ_")
        self.assertEqual(OpenAIConfig.get_env_prefix(), f"{ENV_PREFIX}OPENAI_")


class TestSchedulerConfig(unittest.TestCase):
    def setUp(self):
        self.env_backup = dict(os.environ)
        self._clear_prefixed_env_vars()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env_backup)

    def _clear_prefixed_env_vars(self):
        for key in list(os.environ.keys()):
            if key.startswith(ENV_PREFIX):
                del os.environ[key]

    def test_loads_all_configs_from_env(self):
        """Test loading all configurations from prefixed environment variables"""
        os.environ.update(
            {
                # RabbitMQ configs
                f"{ENV_PREFIX}RABBITMQ_HOST_NAME": "rabbit.test.com",
                f"{ENV_PREFIX}RABBITMQ_USER_NAME": "test_user",
                f"{ENV_PREFIX}RABBITMQ_PASSWORD": "test_pass",
                f"{ENV_PREFIX}RABBITMQ_VIRTUAL_HOST": "test_vhost",
                f"{ENV_PREFIX}RABBITMQ_ERASE_ON_CONNECT": "false",
                f"{ENV_PREFIX}RABBITMQ_PORT": "5673",
                # OpenAI configs
                f"{ENV_PREFIX}OPENAI_API_KEY": "test_api_key",
                f"{ENV_PREFIX}OPENAI_BASE_URL": "https://api.test.openai.com",
                f"{ENV_PREFIX}OPENAI_DEFAULT_MODEL": "gpt-test",
                # GraphDBAuthConfig configs - NOTE THE CORRECT PREFIX!
                f"{ENV_PREFIX}GRAPHDBAUTH_URI": "bolt://test.db:7687",
                f"{ENV_PREFIX}GRAPHDBAUTH_USER": "test_neo4j",
                f"{ENV_PREFIX}GRAPHDBAUTH_PASSWORD": "test_db_pass_123",  # 13 chars (valid)
                f"{ENV_PREFIX}GRAPHDBAUTH_DB_NAME": "test_db",
                f"{ENV_PREFIX}GRAPHDBAUTH_AUTO_CREATE": "false",
            }
        )

        config = AuthConfig.from_local_env()

        # Verify GraphDB configuration
        self.assertEqual(config.graph_db.uri, "bolt://test.db:7687")
        self.assertEqual(config.graph_db.user, "test_neo4j")
        self.assertEqual(config.graph_db.password, "test_db_pass_123")
        self.assertEqual(config.graph_db.db_name, "test_db")
        self.assertFalse(config.graph_db.auto_create)

    def test_uses_default_values_when_env_not_set(self):
        """Test that default values are used when prefixed environment variables are not set"""
        os.environ.update(
            {
                # RabbitMQ
                f"{ENV_PREFIX}RABBITMQ_HOST_NAME": "rabbit.test.com",
                # OpenAI
                f"{ENV_PREFIX}OPENAI_API_KEY": "test_api_key",
                # GraphDB - with correct prefix and valid password length
                f"{ENV_PREFIX}GRAPHDBAUTH_URI": "bolt://test.db:7687",
                f"{ENV_PREFIX}GRAPHDBAUTH_PASSWORD": "default_pass",  # 11 chars (valid)
            }
        )

        config = AuthConfig.from_local_env()

        # Verify default values take effect
        self.assertEqual(config.rabbitmq.port, 5672)  # RabbitMQ default port
        self.assertTrue(config.graph_db.auto_create)  # GraphDB default auto-create

    def test_raises_on_missing_required_variables(self):
        """Test that exceptions are raised when required prefixed variables are missing"""
        with self.assertRaises((ValueError, Exception)) as context:
            AuthConfig.from_local_env()

        error_msg = str(context.exception).lower()
        self.assertTrue(
            "missing" in error_msg or "validation" in error_msg or "required" in error_msg,
            f"Error message does not meet expectations: {error_msg}",
        )

    def test_type_conversion(self):
        """Test type conversion for prefixed environment variables"""
        os.environ.update(
            {
                # RabbitMQ
                f"{ENV_PREFIX}RABBITMQ_HOST_NAME": "rabbit.test.com",
                f"{ENV_PREFIX}RABBITMQ_PORT": "1234",
                f"{ENV_PREFIX}RABBITMQ_ERASE_ON_CONNECT": "yes",
                # OpenAI
                f"{ENV_PREFIX}OPENAI_API_KEY": "test_api_key",
                # GraphDB - correct prefix and valid password
                f"{ENV_PREFIX}GRAPHDBAUTH_URI": "bolt://test.db:7687",
                f"{ENV_PREFIX}GRAPHDBAUTH_PASSWORD": "type_conv_pass",  # 13 chars (valid)
                f"{ENV_PREFIX}GRAPHDBAUTH_AUTO_CREATE": "0",
            }
        )

        config = AuthConfig.from_local_env()

        # Verify type conversion results
        self.assertIsInstance(config.rabbitmq.port, int)
        self.assertIsInstance(config.rabbitmq.erase_on_connect, bool)
        self.assertIsInstance(config.graph_db.auto_create, bool)
        self.assertTrue(config.rabbitmq.erase_on_connect)
        self.assertFalse(config.graph_db.auto_create)

    def test_combined_with_local_config(self):
        """Test priority between prefixed environment variables and config files"""
        with NamedTemporaryFile(mode="w", delete=False, suffix=".yaml") as f:
            f.write("""
            rabbitmq:
              host_name: "file.rabbit.com"
              port: 1234
            openai:
              api_key: "file_api_key"
            graph_db:
              uri: "bolt://file.db:7687"
              password: "file_db_pass"
            """)
            config_file_path = f.name

        try:
            # Environment variables with correct prefixes
            os.environ.update(
                {
                    f"{ENV_PREFIX}RABBITMQ_HOST_NAME": "env.rabbit.com",
                    f"{ENV_PREFIX}OPENAI_API_KEY": "env_api_key",
                    f"{ENV_PREFIX}GRAPHDBAUTH_USER": "env_user",
                    f"{ENV_PREFIX}GRAPHDBAUTH_PASSWORD": "env_db_pass",  # 11 chars (valid)
                }
            )

            # 1. Test loading from config file
            file_config = AuthConfig.from_local_config(Path(config_file_path))
            self.assertEqual(file_config.rabbitmq.host_name, "file.rabbit.com")
            self.assertEqual(file_config.rabbitmq.port, 1234)
            self.assertEqual(file_config.openai.api_key, "file_api_key")
            self.assertEqual(file_config.graph_db.password, "file_db_pass")

            # 2. Test loading from environment variables
            env_config = AuthConfig.from_local_env()
            self.assertEqual(env_config.rabbitmq.host_name, "env.rabbit.com")
            self.assertEqual(env_config.openai.api_key, "env_api_key")
            self.assertEqual(env_config.graph_db.user, "env_user")
            self.assertEqual(env_config.graph_db.password, "env_db_pass")
            self.assertEqual(env_config.rabbitmq.port, 5672)

        finally:
            os.unlink(config_file_path)


class TestConfigUtils(unittest.TestCase):
    """Tests for config_utils functions: flatten_dict and convert_config_to_env"""

    def test_flatten_dict_basic(self):
        """Test basic dictionary flattening without prefix"""
        input_dict = {"database": {"host": "localhost", "port": 5432}, "auth": {"enabled": True}}

        expected = {"DATABASE_HOST": "localhost", "DATABASE_PORT": "5432", "AUTH_ENABLED": "True"}

        self.assertEqual(flatten_dict(input_dict), expected)

    def test_flatten_dict_with_prefix(self):
        """Test dictionary flattening with a custom prefix"""
        input_dict = {"rabbitmq": {"host": "rabbit.local"}}

        expected = {"APP_RABBITMQ_HOST": "rabbit.local"}

        self.assertEqual(flatten_dict(input_dict, prefix="app"), expected)

    def test_flatten_dict_special_chars(self):
        """Test handling of spaces and hyphens in keys"""
        input_dict = {"my key": "value", "other-key": {"nested key": 123}}

        expected = {"MY_KEY": "value", "OTHER_KEY_NESTED_KEY": "123"}

        self.assertEqual(flatten_dict(input_dict), expected)

    def test_flatten_dict_none_values(self):
        """Test handling of None values"""
        input_dict = {"optional": None, "required": "present"}

        expected = {"OPTIONAL": "", "REQUIRED": "present"}

        self.assertEqual(flatten_dict(input_dict), expected)

    def test_convert_json_to_env(self):
        """Test conversion from JSON to .env file"""
        with TemporaryDirectory() as temp_dir:
            input_path = os.path.join(temp_dir, "config.json")
            output_path = os.path.join(temp_dir, ".env")

            # Create test JSON file
            with open(input_path, "w") as f:
                f.write('{"server": {"port": 8080}, "debug": false}')

            # Convert to .env
            convert_config_to_env(input_path, output_path, prefix="app")

            # Verify output
            with open(output_path) as f:
                content = f.read()

            self.assertIn('APP_SERVER_PORT="8080"', content)
            self.assertIn('APP_DEBUG="False"', content)

    def test_convert_yaml_to_env(self):
        """Test conversion from YAML to .env file"""
        with TemporaryDirectory() as temp_dir:
            input_path = os.path.join(temp_dir, "config.yaml")
            output_path = os.path.join(temp_dir, ".env")

            # Create test YAML file
            with open(input_path, "w") as f:
                f.write("""
                    database:
                      host: db.example.com
                      credentials:
                        user: admin
                        pass: secret
                    """)

            # Convert to .env
            convert_config_to_env(input_path, output_path)

            # Verify output
            with open(output_path) as f:
                content = f.read()

            self.assertIn('DATABASE_HOST="db.example.com"', content)
            self.assertIn('DATABASE_CREDENTIALS_USER="admin"', content)
            self.assertIn('DATABASE_CREDENTIALS_PASS="secret"', content)

    def test_convert_with_special_values(self):
        """Test conversion with values containing quotes and special characters"""
        with TemporaryDirectory() as temp_dir:
            input_path = os.path.join(temp_dir, "config.json")
            output_path = os.path.join(temp_dir, ".env")

            # Create test JSON with special values
            with open(input_path, "w") as f:
                f.write('{"description": "Hello \\"World\\"", "empty": null}')

            # Convert to .env
            convert_config_to_env(input_path, output_path)

            # Verify output
            with open(output_path) as f:
                content = f.read()

            # Values with double quotes should not have surrounding quotes
            self.assertIn('DESCRIPTION=Hello "World"', content)
            self.assertIn('EMPTY=""', content)

    def test_unsupported_file_format(self):
        """Test error handling for unsupported file formats"""
        with TemporaryDirectory() as temp_dir:
            input_path = os.path.join(temp_dir, "config.txt")
            with open(input_path, "w") as f:
                f.write("some content")

            with self.assertRaises(ValueError) as context:
                convert_config_to_env(input_path)

            self.assertIn("Unsupported file format", str(context.exception))

    def test_file_not_found(self):
        """Test error handling for non-existent input file"""
        with self.assertRaises(FileNotFoundError):
            convert_config_to_env("non_existent_file.json")

    def test_invalid_json(self):
        """Test error handling for invalid JSON"""
        with TemporaryDirectory() as temp_dir:
            input_path = os.path.join(temp_dir, "bad.json")
            with open(input_path, "w") as f:
                f.write('{"invalid": json}')  # Invalid JSON

            with self.assertRaises(ValueError) as context:
                convert_config_to_env(input_path)

            self.assertIn("Error parsing file", str(context.exception))

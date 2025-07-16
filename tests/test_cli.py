"""
Tests for the MemOS CLI tool.
"""

import zipfile

from io import BytesIO
from unittest.mock import MagicMock, mock_open, patch

import pytest
import requests

from memos.cli import download_examples, export_openapi, main


class TestExportOpenAPI:
    """Test the export_openapi function."""

    @patch("memos.api.start_api.app")
    @patch("builtins.open", new_callable=mock_open)
    @patch("os.makedirs")
    def test_export_openapi_success(self, mock_makedirs, mock_file, mock_app):
        """Test successful OpenAPI export."""
        mock_openapi_data = {"openapi": "3.0.0", "info": {"title": "Test API"}}
        mock_app.openapi.return_value = mock_openapi_data

        result = export_openapi("/test/path/openapi.json")

        assert result is True
        mock_makedirs.assert_called_once_with("/test/path", exist_ok=True)
        mock_file.assert_called_once_with("/test/path/openapi.json", "w")

    @patch("memos.api.start_api.app")
    @patch("builtins.open", side_effect=OSError("Permission denied"))
    def test_export_openapi_error(self, mock_file, mock_app):
        """Test OpenAPI export when file writing fails."""
        mock_app.openapi.return_value = {"test": "data"}

        with pytest.raises(IOError):
            export_openapi("/invalid/path/openapi.json")


class TestDownloadExamples:
    """Test the download_examples function."""

    def create_mock_zip_content(self):
        """Create mock zip file content for testing."""
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zip_file:
            zip_file.writestr("MemOS-main/examples/test_example.py", "# Test example content")
            zip_file.writestr(
                "MemOS-main/examples/subfolder/another_example.py", "# Another example"
            )
        return zip_buffer.getvalue()

    @patch("requests.get")
    @patch("os.makedirs")
    @patch("builtins.open", new_callable=mock_open)
    def test_download_examples_success(self, mock_file, mock_makedirs, mock_requests):
        """Test successful examples download."""
        mock_response = MagicMock()
        mock_response.content = self.create_mock_zip_content()
        mock_requests.return_value = mock_response

        result = download_examples("/test/dest")

        assert result is True
        mock_requests.assert_called_once_with(
            "https://github.com/MemTensor/MemOS/archive/refs/heads/main.zip"
        )
        mock_response.raise_for_status.assert_called_once()

    @patch("requests.get")
    def test_download_examples_error(self, mock_requests):
        """Test download examples when request fails."""
        mock_requests.side_effect = requests.RequestException("Network error")

        result = download_examples("/test/dest")

        assert result is False


class TestMainCLI:
    """Test the main CLI function."""

    @patch("memos.cli.download_examples")
    def test_main_download_examples(self, mock_download):
        """Test main function with download_examples command."""
        mock_download.return_value = True

        with patch("sys.argv", ["memos", "download_examples", "--dest", "/test/dest"]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 0
            mock_download.assert_called_once_with("/test/dest")

    @patch("memos.cli.export_openapi")
    def test_main_export_openapi(self, mock_export):
        """Test main function with export_openapi command."""
        mock_export.return_value = True

        with patch("sys.argv", ["memos", "export_openapi", "--output", "/test/openapi.json"]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 0
            mock_export.assert_called_once_with("/test/openapi.json")

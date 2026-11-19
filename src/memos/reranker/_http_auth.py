from typing import TYPE_CHECKING

from requests.auth import AuthBase


if TYPE_CHECKING:
    from requests import PreparedRequest


class BearerTokenAuth(AuthBase):
    """Supply an explicit Requests auth handler so .netrc cannot replace the token."""

    def __init__(self, token: str) -> None:
        self.token = token

    def __call__(self, request: "PreparedRequest") -> "PreparedRequest":
        request.headers.setdefault("Authorization", f"Bearer {self.token}")
        return request

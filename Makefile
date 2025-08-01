.PHONY: test

install:
	poetry install --extras all --with dev --with test
	poetry run pre-commit install --install-hooks

clean:
	rm -rf .memos
	rm -rf .pytest_cache
	rm -rf .ruff_cache
	rm -rf tmp

test:
	poetry run pytest tests

format:
	poetry run ruff check --fix
	poetry run ruff format

pre_commit:
	poetry run pre-commit run -a

serve:
	poetry run uvicorn memos.api.start_api:app

openapi:
	poetry run memos export_openapi --output docs/openapi.json

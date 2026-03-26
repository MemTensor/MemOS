.PHONY: test test-report test-cov

install:
	poetry install --extras all --with dev --with test
	poetry run pre-commit install --install-hooks

clean:
	rm -rf .memos
	rm -rf .pytest_cache
	rm -rf .ruff_cache
	rm -rf tmp
	rm -rf report cov-report
	rm -f .coverage .coverage.*

test:
	poetry run pytest tests

test-report:
	poetry run pytest tests -vv --durations=10 \
		--html=report/index.html \
		--cov=src/memos \
		--cov-report=term-missing \
		--cov-report=html:cov-report/src

test-cov:
	poetry run pytest tests \
		--cov=src/memos \
		--cov-report=term-missing \
		--cov-report=html:cov-report/src

format:
	poetry run ruff check --fix
	poetry run ruff format

pre_commit:
	poetry run pre-commit run -a

serve:
	poetry run uvicorn memos.api.server_api:app

openapi:
	poetry run memos export_openapi --output docs/openapi.json

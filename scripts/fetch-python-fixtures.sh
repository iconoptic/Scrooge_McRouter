#!/usr/bin/env bash
# Download a corpus of real-world Python files into tests/fixtures/python/
# for stress-testing the outliner. The directory is .gitignore'd; this script
# is the source of truth for what gets fetched.
#
# Run from repo root:  bash scripts/fetch-python-fixtures.sh
#
# Goal: cover a wide variety of styles — stdlib, typing-heavy libs, tests
# with example code embedded in docstrings, big single-file modules, etc.

set -euo pipefail

DEST="$(dirname "$0")/../tests/fixtures/python"
mkdir -p "$DEST"

fetch() {
    local url="$1"
    local out="$DEST/$2"
    if [[ -f "$out" ]]; then
        echo "skip   $2"
        return
    fi
    echo "fetch  $2"
    curl -fsSL "$url" -o "$out"
}

# CPython stdlib — broad surface, complex docstrings, many classes/defs.
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/json/__init__.py            cpython_json_init.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/json/decoder.py             cpython_json_decoder.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/json/encoder.py             cpython_json_encoder.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/asyncio/events.py           cpython_asyncio_events.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/asyncio/tasks.py            cpython_asyncio_tasks.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/typing.py                   cpython_typing.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/dataclasses.py              cpython_dataclasses.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/functools.py                cpython_functools.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/pathlib.py                  cpython_pathlib.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/argparse.py                 cpython_argparse.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/textwrap.py                 cpython_textwrap.py

# Popular third-party libraries — heavy use of decorators, type hints, etc.
fetch https://raw.githubusercontent.com/psf/requests/v2.32.3/src/requests/api.py               requests_api.py
fetch https://raw.githubusercontent.com/psf/requests/v2.32.3/src/requests/models.py            requests_models.py
fetch https://raw.githubusercontent.com/psf/requests/v2.32.3/src/requests/sessions.py          requests_sessions.py
fetch https://raw.githubusercontent.com/pallets/flask/3.0.3/src/flask/app.py                   flask_app.py
fetch https://raw.githubusercontent.com/pallets/click/8.1.7/src/click/core.py                  click_core.py
fetch https://raw.githubusercontent.com/django/django/4.2.16/django/db/models/base.py          django_models_base.py
fetch https://raw.githubusercontent.com/encode/httpx/0.27.2/httpx/_client.py                   httpx_client.py
fetch https://raw.githubusercontent.com/pydantic/pydantic/v2.9.2/pydantic/main.py              pydantic_main.py
fetch https://raw.githubusercontent.com/tiangolo/fastapi/0.115.0/fastapi/routing.py            fastapi_routing.py
fetch https://raw.githubusercontent.com/numpy/numpy/v2.1.0/numpy/_core/numeric.py              numpy_core_numeric.py

# Adversarial: docs/tests where Python code is embedded inside docstrings or
# example strings (the kind of file that historically tripped up our regex).
fetch https://raw.githubusercontent.com/sphinx-doc/sphinx/v8.0.2/sphinx/ext/autodoc/__init__.py sphinx_autodoc_init.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/doctest.py                  cpython_doctest.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/test/test_doctest.py        cpython_test_doctest.py
fetch https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/test/test_typing.py         cpython_test_typing.py

echo
echo "done. $(ls "$DEST" | wc -l) fixture file(s) in $DEST"

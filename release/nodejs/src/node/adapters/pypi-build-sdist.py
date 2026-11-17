"""The PEP 517 frontend the pypi adapter runs inside an isolated environment.

Run with the project directory as the working directory:
  requires <backend> [<backend-path>...]       prints the backend's extra sdist requirements, one per line
  build <out dir> <backend> [<backend-path>...] builds the sdist into <out dir> and prints its file name
Whatever the backend writes to stdout is sent to stderr, so stdout carries the answer alone.
"""

import importlib
import os
import sys


def load_backend(reference, backend_path):
    for entry in reversed(backend_path):
        sys.path.insert(0, os.path.abspath(entry))
    module, _, attributes = reference.partition(":")
    backend = importlib.import_module(module.strip())
    for attribute in filter(None, attributes.strip().split(".")):
        backend = getattr(backend, attribute)
    return backend


def main(argv):
    mode = argv[0]
    out = argv[1] if mode == "build" else None
    rest = argv[2:] if mode == "build" else argv[1:]
    stdout = os.dup(1)
    os.dup2(2, 1)
    try:
        backend = load_backend(rest[0], rest[1:])
        if mode == "requires":
            hook = getattr(backend, "get_requires_for_build_sdist", None)
            answer = "".join(f"{requirement}\n" for requirement in (hook({}) if hook else []))
        elif mode == "build":
            answer = f"{backend.build_sdist(out, {})}\n"
        else:
            raise SystemExit(f"unknown mode {mode!r}")
    finally:
        sys.stdout.flush()
        os.dup2(stdout, 1)
    os.write(1, answer.encode("utf-8"))


main(sys.argv[1:])

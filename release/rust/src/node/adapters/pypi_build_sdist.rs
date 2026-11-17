//! The PEP 517 frontend the pypi evidence runs, as text: the bytes of the Node
//! half's `pypi-build-sdist.py`, embedded so both halves run the one file.

pub const PYPI_BUILD_SDIST_SCRIPT: &str = include_str!("../../../../nodejs/src/node/adapters/pypi-build-sdist.py");

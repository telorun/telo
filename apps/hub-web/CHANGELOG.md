# Changelog

## 0.1.1 - 2026-11-15
### Fixed
* The image is built from only the files it uses: a `Dockerfile.dockerignore` beside the Dockerfile admits the workspace packages it installs and the inputs of the root `prepare`, and the install is filtered to this image's packages.

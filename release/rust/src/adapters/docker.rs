//! The `docker` ecosystem's pure half: an anchor holding a `Dockerfile` is one
//! image. An image keeps no version of its own — it is tagged with its unit's.
//! Its settings say where it is pushed (`registry`, `name`) and which directory
//! it is built from (`context`).

use std::sync::{Arc, LazyLock};

use crate::adapter::{AnchorProbe, EcosystemAdapter, RecognizedPackage};
use crate::marker_schema::{KeySchemas, KeyType, WorkspaceKeySchema};

pub const DOCKERFILE: &str = "Dockerfile";

pub struct DockerAdapter;

impl EcosystemAdapter for DockerAdapter {
    fn ecosystem(&self) -> &'static str {
        "docker"
    }

    fn anchor_description(&self) -> &'static str {
        "a directory holding a Dockerfile"
    }

    fn keys(&self) -> KeySchemas {
        vec![
            (
                "registry",
                WorkspaceKeySchema {
                    ty: KeyType::String,
                    description: "Image repository base the image is pushed under, as `<registry>/<name>`.",
                    examples: &["ghcr.io/acme"],
                    entry: None,
                },
            ),
            (
                "name",
                WorkspaceKeySchema {
                    ty: KeyType::String,
                    description: "The image's name under its registry. Omitted: the anchor directory's own name.",
                    examples: &[],
                    entry: None,
                },
            ),
            (
                "context",
                WorkspaceKeySchema {
                    ty: KeyType::Directory,
                    description: "The build context, a workspace-relative directory ('.' the workspace root). Omitted: the anchor directory. Its ignore file is <Dockerfile>.dockerignore beside the Dockerfile, else the context's .dockerignore.",
                    examples: &["."],
                    entry: None,
                },
            ),
        ]
    }

    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage> {
        probe.read_file(DOCKERFILE)?;
        Some(RecognizedPackage { name: None, contributes_layer: true, version_files: Vec::new() })
    }
}

pub static DOCKER_ADAPTER: LazyLock<Arc<DockerAdapter>> = LazyLock::new(|| Arc::new(DockerAdapter));

use std::io;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use super::docker::{PullPolicy, TauriDockerConfig};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AvailabilityReport {
    Ready,
    NeedsSetup { issues: Vec<ConfigIssue> },
    Unavailable {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        remediation: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigIssue {
    pub path: String,
    pub message: String,
}

pub async fn probe(config: &TauriDockerConfig) -> AvailabilityReport {
    match docker_version(config.docker_host.as_deref()).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return AvailabilityReport::Unavailable {
                message: "Docker CLI not found in PATH.".into(),
                remediation: Some("Install Docker Desktop or the Docker Engine.".into()),
            };
        }
        Err(_) | Ok(false) => return daemon_unreachable(config.docker_host.as_deref()),
        Ok(true) => {}
    }

    if config.pull_policy != PullPolicy::Always {
        match docker_image_inspect(&config.image, config.docker_host.as_deref()).await {
            Ok(true) => {}
            Ok(false) | Err(_) => {
                if config.pull_policy == PullPolicy::Never {
                    return AvailabilityReport::Unavailable {
                        message: format!(
                            "Image {} not present locally and pullPolicy is 'never'.",
                            config.image
                        ),
                        remediation: Some(format!(
                            "Run docker pull {} or change pullPolicy.",
                            config.image
                        )),
                    };
                }
                // pullPolicy == "missing": `docker run` will pull on first use.
            }
        }
    }

    AvailabilityReport::Ready
}

fn daemon_unreachable(docker_host: Option<&str>) -> AvailabilityReport {
    match docker_host {
        Some(host) if !host.is_empty() => AvailabilityReport::NeedsSetup {
            issues: vec![ConfigIssue {
                path: "/dockerHost".into(),
                message: format!("Cannot connect to Docker daemon at {host}."),
            }],
        },
        _ => AvailabilityReport::Unavailable {
            message: "Docker daemon not reachable.".into(),
            remediation: Some(
                "Start Docker Desktop or ensure the docker socket is accessible.".into(),
            ),
        },
    }
}

async fn docker_version(docker_host: Option<&str>) -> io::Result<bool> {
    let mut cmd = Command::new("docker");
    cmd.arg("version").arg("--format").arg("{{.Server.Version}}");
    apply_docker_host(&mut cmd, docker_host);

    let out = tokio::time::timeout(Duration::from_secs(2), cmd.output())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "docker version timed out"))??;
    Ok(out.status.success())
}

async fn docker_image_inspect(image: &str, docker_host: Option<&str>) -> io::Result<bool> {
    let mut cmd = Command::new("docker");
    cmd.arg("image").arg("inspect").arg(image);
    apply_docker_host(&mut cmd, docker_host);
    let out = cmd.output().await?;
    Ok(out.status.success())
}

fn apply_docker_host(cmd: &mut Command, docker_host: Option<&str>) {
    if let Some(host) = docker_host {
        if !host.is_empty() {
            cmd.env("DOCKER_HOST", host);
        }
    }
}

//! Which package manager packs an npm anchor: the `packageManager` field of
//! the nearest `package.json` at or above it (never past the workspace), else
//! the one lockfile found nearest it. Two lockfiles of different managers in
//! one directory is an error, never a guess.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ReleaseError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Npm,
    Pnpm,
    YarnClassic,
    YarnBerry,
    Bun,
}

impl PackageManager {
    pub fn as_str(self) -> &'static str {
        match self {
            PackageManager::Npm => "npm",
            PackageManager::Pnpm => "pnpm",
            PackageManager::YarnClassic => "yarn-classic",
            PackageManager::YarnBerry => "yarn-berry",
            PackageManager::Bun => "bun",
        }
    }
}

const LOCKFILES: &[(&str, &str)] = &[
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
];

fn parent(dir: &Path) -> Option<PathBuf> {
    dir.parent().map(Path::to_path_buf)
}

pub fn detect_package_manager(anchor_dir: &Path, root: &Path) -> Result<PackageManager, ReleaseError> {
    let mut dir = anchor_dir.to_path_buf();
    loop {
        let manifest = dir.join("package.json");
        if manifest.exists() {
            let text = fs::read_to_string(&manifest).map_err(|err| ReleaseError::new(format!("{}: {err}", manifest.display())))?;
            let value: Value = serde_json::from_str(&text).map_err(|err| ReleaseError::new(format!("{}: {err}", manifest.display())))?;
            if let Some(field) = value.get("packageManager").and_then(Value::as_str) {
                return from_field(field, &manifest.display().to_string());
            }
        }
        match parent(&dir) {
            Some(up) if dir != root => dir = up,
            _ => break,
        }
    }
    let mut dir = anchor_dir.to_path_buf();
    loop {
        let found: Vec<&(&str, &str)> = LOCKFILES.iter().filter(|(name, _)| dir.join(name).exists()).collect();
        let mut managers: Vec<&str> = Vec::new();
        for (_, manager) in &found {
            if !managers.contains(manager) {
                managers.push(manager);
            }
        }
        if managers.len() > 1 {
            return Err(ReleaseError::new(format!(
                "{} holds lockfiles of {} ({}), so which one packs '{}' cannot be decided. Remove one, or name the manager in package.json's 'packageManager'.",
                dir.display(),
                managers.join(" and "),
                found.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", "),
                anchor_dir.display()
            )));
        }
        if let Some(manager) = managers.first() {
            return Ok(match *manager {
                "npm" => PackageManager::Npm,
                "pnpm" => PackageManager::Pnpm,
                "bun" => PackageManager::Bun,
                _ => {
                    let lock = fs::read_to_string(dir.join("yarn.lock")).unwrap_or_default();
                    if lock.split('\n').any(|line| line.starts_with("__metadata:")) {
                        PackageManager::YarnBerry
                    } else {
                        PackageManager::YarnClassic
                    }
                }
            });
        }
        match parent(&dir) {
            Some(up) if dir != root => dir = up,
            _ => break,
        }
    }
    Err(ReleaseError::new(format!(
        "No package manager is named for '{}': no 'packageManager' in a package.json at or above it and no lockfile. Name one in package.json's 'packageManager' (e.g. \"pnpm@9.0.0\").",
        anchor_dir.display()
    )))
}

fn from_field(field: &str, at: &str) -> Result<PackageManager, ReleaseError> {
    let mut parts = field.split('@');
    let name = parts.next().unwrap_or("");
    let version = parts.next().unwrap_or("");
    match name {
        "npm" => Ok(PackageManager::Npm),
        "pnpm" => Ok(PackageManager::Pnpm),
        "bun" => Ok(PackageManager::Bun),
        "yarn" if version.starts_with("1.") => Ok(PackageManager::YarnClassic),
        "yarn" => Ok(PackageManager::YarnBerry),
        _ => Err(ReleaseError::new(format!(
            "{at}: packageManager '{field}' names no manager this adapter drives (npm, pnpm, yarn, bun)."
        ))),
    }
}

/// The command packing the package in its directory into `destination`.
pub fn pack_command(manager: PackageManager, destination: &Path) -> (&'static str, Vec<String>) {
    let dest = destination.display().to_string();
    let file = destination.join("package.tgz").display().to_string();
    match manager {
        PackageManager::Npm => ("npm", vec!["pack".into(), "--pack-destination".into(), dest]),
        PackageManager::Pnpm => ("pnpm", vec!["pack".into(), "--pack-destination".into(), dest]),
        PackageManager::YarnClassic => ("yarn", vec!["pack".into(), "--filename".into(), file]),
        PackageManager::YarnBerry => ("yarn", vec!["pack".into(), "--out".into(), file]),
        PackageManager::Bun => ("bun", vec!["pm".into(), "pack".into(), "--destination".into(), dest]),
    }
}

/// Managers with no workspace protocol: a sibling is named by a plain range.
pub fn uses_plain_ranges(manager: PackageManager) -> bool {
    matches!(manager, PackageManager::Npm | PackageManager::YarnClassic)
}

//! The placement of findings: what a finding carries into the finishing step. A partial twin of
//! `../../nodejs/src/placement.ts`, holding only what the requires gate's cover reads: each
//! finding's provenance — its file, read before any finding is moved, and the refusals it is
//! (`CarriedCover`) — recorded by the world's `refusals` in Node's step order. Node rides the
//! provenance on the diagnostic under a symbol no serialization sees; here it rides beside it
//! ([`PlacedDiagnostic`]) and the finishing step strips it.
//!
//! Owed, with the passes that produce what they move: forward views, scope members, extraction
//! origins and the form refusals, template bodies and expansions (3e-19 and 3d-18). Until then
//! no finding is moved, so a finding's place is the place its pass reported.

use std::rc::Rc;

use crate::types::AnalysisDiagnostic;

/// What a carried cover tests: whether it covers `diagnostic`, given that finding's provenance.
pub type CoverTest = dyn Fn(&AnalysisDiagnostic, &Provenance) -> bool;

/// A refusal a finding carries: what it covers holds only where it does not.
pub struct CarriedCover {
    /// The written places it covers (`finishing_pipeline::cover_key`, `file_cover_key`);
    /// absent, the refusal's own declaration.
    pub keys: Option<Vec<String>>,
    pub covers: Rc<CoverTest>,
}

/// What placement knew of a finding before it moved it.
#[derive(Clone, Default)]
pub struct Provenance {
    /// Its file, before any finding is moved.
    pub file: Option<String>,
    /// The refusals it is.
    pub refuses: Vec<Rc<CarriedCover>>,
}

/// A finding in written coordinates, with its provenance.
pub struct PlacedDiagnostic {
    pub diagnostic: AnalysisDiagnostic,
    pub provenance: Provenance,
}

/// The refusals a finding is, given the finding and its file.
pub type Refusals<'a> = dyn Fn(&AnalysisDiagnostic, Option<&str>) -> Option<Vec<Rc<CarriedCover>>> + 'a;

/// What one world places its findings through.
#[derive(Default)]
pub struct PlacementWorld<'a> {
    /// The refusals a finding is.
    pub refusals: Option<&'a Refusals<'a>>,
}

pub struct Placement<'a> {
    world: PlacementWorld<'a>,
}

impl<'a> Placement<'a> {
    pub fn new(world: PlacementWorld<'a>) -> Self {
        Self { world }
    }

    /// Each of `found` in written coordinates, carrying its provenance.
    pub fn place(&self, found: Vec<AnalysisDiagnostic>) -> Vec<PlacedDiagnostic> {
        found
            .into_iter()
            .map(|diagnostic| {
                let file = diagnostic.data.as_ref().and_then(|data| data.file_path.clone());
                let refuses = self.world.refusals.and_then(|refusals| refusals(&diagnostic, file.as_deref())).unwrap_or_default();
                PlacedDiagnostic { diagnostic, provenance: Provenance { file, refuses } }
            })
            .collect()
    }
}

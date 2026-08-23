/**
 * A typed binding to pdfmake: a declared document — page setup, named styles,
 * embedded fonts, and a tree of content nodes — rendered to PDF bytes.
 *
 * The node vocabulary mirrors pdfmake's document definition verbatim (see the
 * `PdfMake.Node` carrier), so an example from its documentation pastes in and
 * works. The one place it is not a mirror is where pdfmake takes a callback: a
 * manifest holds no functions and pdfmake invokes them synchronously during
 * layout, so table layout is declared as data instead.
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as DocumentController from "./document-controller.js";

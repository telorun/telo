// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment. The implementation is the SQL family's shared one,
// reached through its module's code specifier, so it is one module scope
// across engines — which is what keeps one queue-name registry per table.
export { Queue } from "@telorun/queue-sql";

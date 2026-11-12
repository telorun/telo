# Changelog

## 0.2.0 - 2026-11-12
### Added
* New module: a rendezvous that hands one value from a call delivering it to a call waiting for it under the same key. Rendezvous.Await blocks with a required timeout and cancellation, Rendezvous.Deliver supplies a payload typed by the point's payloadType, and Rendezvous.MemoryPoint is the in-process point; the point contract ships as @telorun/rendezvous so another module can implement it.

# Changelog

## 0.2.3 - 2026-11-09
### Fixed
* The restriction's lower bound named telo 0.130.0, which was never published; it now names 0.131.0, the first published release at or above it.

## 0.2.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* New module. Broadcast tells every running instance that something happened: Broadcast.Channel is the abstract (name, messageType, maxBytes) a transport implements through the channel interface in @telorun/broadcast, Broadcast.MemoryChannel carries messages within one running application, Broadcast.Publish sends a message optionally under a dot-separated topic (a message over maxBytes is ERR_BROADCAST_MESSAGE_TOO_LARGE, a channel that cannot send is ERR_BROADCAST_UNAVAILABLE), and Broadcast.Subscription invokes its invoke with its inputs evaluated over topic and message for each message matching its topics patterns (* for one segment, a final > for one or more), at most concurrency at a time with a bounded buffer, reporting a failure to onError and a gap, when messages may have been missed, to onGap. Delivery is live and at most once.

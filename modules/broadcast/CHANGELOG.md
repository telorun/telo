# Changelog

## 0.2.0 - 2026-11-06
### Added
* New module. Broadcast tells every running instance that something happened: Broadcast.Channel is the abstract (name, messageType, maxBytes) a transport implements through the channel interface in @telorun/broadcast, Broadcast.MemoryChannel carries messages within one running application, Broadcast.Publish sends a message optionally under a dot-separated topic (a message over maxBytes is ERR_BROADCAST_MESSAGE_TOO_LARGE, a channel that cannot send is ERR_BROADCAST_UNAVAILABLE), and Broadcast.Subscription invokes its invoke with its inputs evaluated over topic and message for each message matching its topics patterns (* for one segment, a final > for one or more), at most concurrency at a time with a bounded buffer, reporting a failure to onError and a gap, when messages may have been missed, to onGap. Delivery is live and at most once.

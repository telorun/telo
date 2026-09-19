# Changelog

## 0.2.0 - 2026-09-19
### Added
* Channel.SendLine and Channel.ReadUntil report what actually went wrong: writing to a program that has not started is ERR_CHANNEL_NOT_STARTED rather than a closed-channel error, and a second read while one is already waiting is ERR_CHANNEL_CONCURRENT_READ rather than two reads silently interleaving what they consume.
* Channel.Text, Channel.SendLine, Channel.ReadUntil and Channel.End: hold a conversation with a running program over a line-oriented text channel. Read up to a literal marker, answer what it asked, and close its input when the exchange is over. Reads are bounded and report the text that arrived instead of the marker, so a stuck exchange says why rather than hanging. Branching on what came back is the ordinary step grammar.

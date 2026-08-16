---
"@telorun/http-server": minor
---

A multipart request body is accepted out of the box, as raw bytes. Fastify ships
parsers for JSON and urlencoded only, so a route receiving a file upload answered
415 before any handler ran — naming a media type the author really did send and
pointing at no fix, with `contentTypeParsers` something every such server had to
discover first. Raw rather than text, because decoding a multipart body as a
string corrupts every binary part and the parts are the point. A
`contentTypeParsers` entry naming an exact multipart type still works and takes
precedence for that type.

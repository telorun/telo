# Changelog

## 0.2.0 - 2026-11-04
### Added
* New module. MailResend.Transport sends email through the Resend API (POST <baseUrl>/emails) behind the Mail.Transport contract, as a templated kind with no controller. It is configured with apiKey (sent as a bearer token), a required default from, and baseUrl (https://api.resend.com when omitted). Addresses are sent as strings, { name, address } as Name <address> with the name quoted when it holds a separator, to, cc and bcc always as lists, replyTo as reply_to and attachment content base64-encoded. The result is Resend's id as messageId with every to, cc and bcc address accepted and rejected empty. A 4xx other than 408 and 429 is ERR_MAIL_REJECTED; 408, 429, any other non-2xx answer, a 2xx without an id and an unreachable endpoint are ERR_MAIL_UNAVAILABLE, the message carrying Resend's own explanation. Requires telo 0.128.0 or newer.

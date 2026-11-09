# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.2.0 - 2026-11-04
### Added
* New module. SmsTwilio.Transport sends text messages through the Twilio Messages API (POST <baseUrl>/2010-04-01/Accounts/<accountSid>/Messages.json, a form body of To, From and Body) behind the Sms.Transport contract, as a templated kind with no controller. It is configured with accountSid (AC and 32 hex digits) and authToken, sent as HTTP Basic credentials, a required default from number in E.164 form, and baseUrl (https://api.twilio.com when omitted). The result is Twilio's message SID as messageId, with status sent when Twilio reports sent or delivered and queued for any other accepted status. A 4xx other than 408 and 429 is ERR_SMS_REJECTED; 408, 429, any other non-2xx answer, a 2xx without a SID and an unreachable endpoint are ERR_SMS_UNAVAILABLE, the message carrying Twilio's own error code and explanation. Requires telo 0.128.0 or newer.

# Task: add a field to leads

Leads may now carry the contact phone number of the person who submitted them.

- The request body of `POST /leads/light`, `/leads/medium` and `/leads/heavy` accepts one more member, `phone`: a string of at least 7 characters. It is **optional** — a body without it is still valid, and every other member stays required.
- A body whose `phone` is present but is not a string, or is a string shorter than 7 characters, is invalid: `400` with code `ERR_INPUT_INVALID`, nothing stored.
- A stored lead keeps what was sent: `phone` appears in `lead` of the `201` answer and of `GET /leads/{id}`. A lead sent without it has no `phone` member in `lead`.
- Nothing else changes: no level derives anything from `phone`, and every case of `CONTRACT.md` that does not send `phone` behaves as before.

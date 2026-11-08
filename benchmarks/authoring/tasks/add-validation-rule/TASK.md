# Task: add a validation rule

A new rule applies to `POST /leads/light`, `/leads/medium` and `/leads/heavy`:

- A lead on the `enterprise` plan must have at least 50 employees. A body that is otherwise valid but has `plan` `enterprise` and `company.employees` below 50 is invalid: `400` with code `ERR_INPUT_INVALID`, nothing stored.
- Every other combination keeps its answer: `enterprise` with 50 employees or more is `201`, and any other plan is `201` whatever its `company.employees`.
- Nothing else changes.

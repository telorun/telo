# Task: add a statistics endpoint

### `GET /stats`

`200` with the number of leads stored, in total and per plan:

```json
{ "total": 4, "byPlan": { "free": 1, "trial": 0, "starter": 1, "growth": 2, "enterprise": 0 } }
```

- `total` counts every lead in the database, the `seed` lead included, whichever level created it; `byPlan` has one member for each of the five plans (0 for a plan with no lead), and its members add up to `total`.
- It reflects every lead the service has answered `201` for before the request, and none that was rejected with `400`.
- Nothing else changes.

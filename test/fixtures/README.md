# Test Fixtures

Files verified against Newman 6.2.3, openapi-to-postmanv2 6.4.3, and @apidevtools/swagger-parser 13.1 (Node 22). The expected results below are what was obtained when running them; tests must assert exactly these values.

| File | Usage |
|---|---|
| `server.ts` | `startDemoServer()` starts the "Demo API" at `127.0.0.1:<free port>` and returns `{ baseUrl, close }`. Routes: `POST /login`, `GET /users/:id` (requires `Bearer abc`), `GET /slow` (responds after 3s). |
| `collection.json` | Valid collection: folders `Auth/Login` and `Users/Get user`. |
| `environment.json` | `username=ana`, `password=secret`, `userId=7`. |
| `iteration-data.csv` | 2 rows: valid and invalid login. |
| `collection-invalid.json` | 5 items with known errors for tool 7. |
| `openapi.yaml` | OpenAPI 3.0.3 of the Demo API, with `bearerAuth` on `GET /users/{id}`. |
| `swagger2.json` | Swagger 2.0 with one operation. |
| `stories.json` | 4 user stories with expected criterion-extraction results (`source` and count): Spanish Gherkin, English Gherkin, a headed list, and free text. |

In all executions, `envVar: [{ key: "[REDACTED-SECRET]", value: <server baseUrl> }]` is passed.

## Expected Results

**Tool 4, `collection.json` + `environment.json`**: 4 assertions, 0 failures. The Login script emits a `console` event with `token stored`.

**Tool 4, same + `iteration-data.csv`**: 8 assertions, 4 failures (all in iteration 1):
- `Login`: `expected response to have status code 200 but got 401`
- `Login`: `expected undefined to be a string`
- `Get user`: `expected response to have status code 200 but got 401`
- `Get user`: `expected data to satisfy schema but found following errors: …`

**Tool 4 with `timeout: 1000`** on an item calling `/slow`: Newman calls `done` with `err.message === "callback timed out"` at ~1s, with partial `summary` → `aborted: true`.

**Newman executing `collection-invalid.json`** (useful to compare with static validation):
| Item | Runtime error |
|---|---|
| Top-level await | `await is only valid in async functions and the top level bodies of modules` |
| Template in JS | `Unexpected token '{'` |
| Forbidden APIs | `Cannot find module 'crypto'` |
| Wrong pm API | `Cannot read properties of undefined (reading 'set')` |
| Runtime and undefined variables | (no script error) |

**Tool 7 on `collection-invalid.json`** must report at least:
| Item | Rule | Severity |
|---|---|---|
| Top-level await | `syntax` | error |
| Template in JS | `syntax` and `template_in_js` | error |
| Forbidden APIs | `forbidden_api` (`require('crypto')`, `fetch(`, `window.`) | error |
| Wrong pm API | `forbidden_api` (`pm.environmentVariables`) | error |
| Runtime and undefined variables | `runtime_variable` (`sessionId`) | warning |
| Runtime and undefined variables | `undefined_variable` (`neverDefined`) | error |
| All items | `undefined_variable` (`baseUrl`, without collection/environment defining it) | error |

`{{$guid}}` **must not** be reported.

**Tool 9, `openapi.yaml`** with `folderStrategy: "Tags"`: variable `baseUrl=http://127.0.0.1:3000`; items `Auth > Login [POST]` and `Users > Get user [GET]` with `auth.type = "bearer"` and token `{{bearerToken}}`. The tool must declare `bearerToken` as a collection variable (empty).

**Tool 9, `swagger2.json`**: variable `baseUrl=http://127.0.0.1:3000`; item `Users > Get user [GET]`.

**Tool 9, `mode: "sync"`**: if a test is added to `Auth/Login`, the `/health` route is added to the spec, and the `summary` of `getUser` is changed, the result preserves the Login test, renames `Get user` to its new summary, and adds `Health`.

**`collectionSource` (all tools, `collectionLoader`)**, with simulated `fetchImpl`:
- UID `12345678-0a1b2c3d-0a1b-2c3d-4e5f-0a1b2c3d4e5f`: makes `GET https://api.getpostman.com/collections/<uid>` with the `X-Api-Key` header from `POSTMAN_API_KEY` and returns the `.collection` content (the content of `collection.json` wrapped in `{ "collection": … }`).
- UID without `POSTMAN_API_KEY` → `isError` explaining how to set it.
- `http://…` → rejection; `https://…?apikey=[REDACTED-SECRET] → rejection; path outside `NEWMAN_MCP_ROOT` → rejection; JSON without `item` → error.
- A local path to `collection.json` and the same collection over simulated `https://` return the same object.

**Catalog of Tool 1 with `collection.json`** (hand-crafted, `url` as string): `E1` = `POST /login` and `E2` = `GET /users/{{userId}}`, both with `documentedStatus: []` and `responseKeys: {}` because the collection has no response examples.

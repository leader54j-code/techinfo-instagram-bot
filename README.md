# AI-powered Instagram auto-publisher

A NestJS + TypeScript backend that collects allow-listed RSS information, generates conservative Instagram copy with `gpt-4o-mini`, applies local and OpenAI moderation checks, and publishes through the Instagram API from a PostgreSQL-backed queue.

## What is implemented

- Four public task states: `Pending`, `Processing`, `Completed`, and `Failed`.
- Internal stages distinguish collection, generation, readiness, publishing, and rejection.
- PostgreSQL `FOR UPDATE SKIP LOCKED` claims make multiple app instances safe.
- A unique SHA-256 source fingerprint prevents duplicate queue entries.
- Instagram creation IDs are saved before publication, so retries reuse the same container.
- Failed work retries up to three times with exponential backoff; terminal failures are not picked up again.
- Stale processing locks are recovered every ten minutes.
- Exactly three daily publishing opportunities, one at each requested window:
  - 6:00 AM: up to 1 post
  - 1:00 PM: up to 1 post
  - 6:00 PM: up to 1 post
- The daily limit and all cron windows use `APP_TIMEZONE` (default `Asia/Kolkata`).
- Multer stores JPEG uploads in `uploads/`, with an 8 MB default limit and Instagram-compatible 4:5 through 1.91:1 aspect-ratio validation.
- RSS URLs are HTTPS-only and restricted by `ALLOWED_SOURCE_HOSTS` to reduce SSRF and source-quality risk.
- Generation is rejected below confidence `0.75` or relevance `0.65`; both source material and final copy are moderated.

## Run locally

Requirements: Node.js 20+, Docker, an OpenAI API key, a public HTTPS base URL, and an Instagram professional account/token with content publishing permissions.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run build
npm run start:dev
```

Fill in `.env` before starting. In production, `OPENAI_API_KEY`, `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_EXPECTED_USERNAME`, `PUBLIC_BASE_URL`, and `ADMIN_API_KEY` are mandatory. `PUBLIC_BASE_URL` must expose `/media/*` to Instagram over public HTTPS; localhost URLs cannot be fetched by Instagram.

Set `INSTAGRAM_EXPECTED_USERNAME=techinfo534` to bind this deployment to that account. Before its first publish, the service asks Instagram for the username belonging to `INSTAGRAM_USER_ID` and the access token. Publishing stops with an error if the returned username is not `techinfo534`.

The application runs its migration automatically unless `RUN_MIGRATIONS=false`.

## Add a task

Upload a validated JPEG:

```bash
curl -X POST http://localhost:3000/tasks \
  -H "x-admin-api-key: change-me" \
  -F "topic=Space science" \
  -F "sourceUrl=https://www.nasa.gov/example" \
  -F "sourceTitle=Example verified update" \
  -F "sourceExcerpt=Use a sufficiently detailed excerpt copied from the primary source, at least twenty characters long." \
  -F "image=@./post.jpg;type=image/jpeg"
```

Or send JSON with a public HTTPS JPEG URL:

```json
{
  "topic": "Space science",
  "sourceUrl": "https://www.nasa.gov/example",
  "sourceTitle": "Example verified update",
  "sourceExcerpt": "A sufficiently detailed excerpt from the primary source.",
  "imagePublicUrl": "https://cdn.example.com/post.jpg"
}
```

List work with `GET /tasks?status=Pending&limit=25`; inspect a task with `GET /tasks/:id`. All `/tasks` endpoints require `x-admin-api-key` in production.

## Collection and safety behavior

At 5:00 AM the service reads `SOURCE_FEEDS`, accepts only source pages from `ALLOWED_SOURCE_HOSTS`, and queues feed entries that have a public HTTPS JPEG (or `DEFAULT_POST_IMAGE_URL`). A one-minute worker generates at most three ready items per local day. When no eligible pending row exists, the worker performs no work until a new task arrives.

Automated factuality cannot be guaranteed by a language model. This implementation limits generation to supplied primary-source text, stores the source URL and excerpt for audit, requires a confidence threshold, and fails closed on moderation. For higher-risk subject areas, add human approval before changing a task to `Ready`.

## Production notes

- Run more than one replica only against the same PostgreSQL database.
- Put the API behind TLS and a stronger identity-aware gateway; the API-key guard is a minimal baseline.
- Use a durable/shared object store instead of the local `uploads/` directory when deploying multiple replicas.
- Store tokens in a secrets manager and rotate the Instagram access token before expiry.
- Set `INSTAGRAM_GRAPH_BASE_URL` and `INSTAGRAM_GRAPH_VERSION` to the values required by the Instagram login flow and API version used by your Meta app.
- Review source licensing and permissions before republishing source images or text.

The OpenAI integration uses the Responses API with strict JSON-schema output and the moderation endpoint, consistent with the [official OpenAI model documentation](https://developers.openai.com/api/docs/models) and [moderation guide](https://developers.openai.com/api/docs/guides/moderation).

## Free testing mode (Render + GitHub Actions)

Render Free web services sleep after inactivity, so their in-process cron jobs cannot be relied on. For testing, set `ENABLE_INTERNAL_SCHEDULER=false` on Render and use `.github/workflows/instagram-publish.yml`. The workflow wakes the service and calls one authenticated, idempotent publishing slot at approximately 6:05 AM, 1:05 PM, and 6:05 PM in `Asia/Kolkata`.

Create these GitHub repository secrets:

- `RENDER_SERVICE_URL`: the service origin, such as `https://techinfo-instagram-bot.onrender.com` (no trailing slash)
- `ADMIN_API_KEY`: exactly the same secret configured on Render

The workflow can also be tested from GitHub's **Actions → Trigger Instagram publishing slot → Run workflow** menu. A unique `YYYY-MM-DD:slot` key prevents the same slot from completing twice if GitHub retries the request. GitHub scheduled workflows can still be delayed under load, so this mode is suitable for free testing, not exact-time production delivery.

Use a durable public HTTPS JPEG URL while testing. Render Free does not preserve Multer uploads across sleep, restarts, or redeploys.

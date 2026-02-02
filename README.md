# Splash → Webflow Event Sync

Syncs events from Splash to your Webflow Events collection. Runs hourly on Railway (or manually).

## How it works

1. Authenticates with Splash API using OAuth2 client credentials
2. Fetches upcoming events from Splash
3. Checks your Webflow Events collection for existing `Splash-ID` values
4. Creates new CMS items for any events not already synced
5. Creates items as **drafts** so you can review before publishing

## Setup

### 1. Get your API credentials

**Splash:**
- Contact your Splash Customer Success Manager for API access
- You'll receive a `Client ID` and `Client Secret`

**Webflow:**
- Go to Site Settings → Apps & Integrations → API Access
- Generate a new API token with CMS read/write permissions

### 2. Environment variables

Create these in Railway (or a local `.env` file):

```
SPLASH_CLIENT_ID=your_splash_client_id
SPLASH_CLIENT_SECRET=your_splash_client_secret
WEBFLOW_API_TOKEN=your_webflow_api_token
WEBFLOW_COLLECTION_ID=69650c17f7e5c3ac3938b16d
```

### 3. Test locally first

```bash
# Install nothing - uses native fetch (Node 18+)
npm run debug
```

This will show you the raw Splash API response so you can verify field mappings.

### 4. Deploy to Railway

```bash
# Push to GitHub, then connect repo to Railway
# Or use Railway CLI:
railway login
railway init
railway up
```

The `railway.toml` configures it to run every hour automatically.

## Field mapping

| Webflow Field | Splash Field (adjust in index.js) |
|---------------|-----------------------------------|
| name | title / name |
| date | event_start / start_date / date |
| time | (parsed from date) |
| location-city | venue.city / city |
| location-state | venue.state / state |
| thumbnail | image_url / thumbnail / photo.url |
| splash-url | url / event_url / registration_url |
| splash-id | id |
| description | description / about |
| event-type | event_type / type |

**If fields aren't mapping correctly:**
1. Run `npm run debug` to see raw Splash data
2. Update the `mapSplashToWebflow()` function in `index.js`

## Troubleshooting

**"Splash auth failed"**
- Double-check your Client ID and Secret
- Make sure your Splash account has API access enabled

**"Webflow create failed"**
- Check your API token has CMS write permissions
- Verify the Collection ID is correct
- Check Webflow's rate limits (60/min)

**Events not appearing in Webflow**
- They're created as drafts — check the CMS drafts section
- Run `npm run debug` to verify Splash is returning events

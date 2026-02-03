/**
 * Splash → Webflow Event Sync
 *
 * Polls Splash for events and creates them in Webflow CMS.
 * Uses Splash-ID field to prevent duplicates.
 * Sends Slack notification when new events are synced.
 *
 * Environment variables required:
 * - SPLASH_CLIENT_ID
 * - SPLASH_CLIENT_SECRET
 * - SPLASH_USERNAME (your Splash login email)
 * - SPLASH_PASSWORD (your Splash login password)
 * - WEBFLOW_API_TOKEN
 * - WEBFLOW_COLLECTION_ID (default: 69650c17f7e5c3ac3938b16d)
 * - SLACK_WEBHOOK_URL (optional, for notifications)
 */

const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69650c17f7e5c3ac3938b16d';
const SPLASH_API_BASE = 'https://api.splashthat.com';
const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';

// ============================================
// SLACK NOTIFICATIONS
// ============================================

async function sendSlackNotification(events) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('No SLACK_WEBHOOK_URL configured, skipping notification');
    return;
  }

  const eventList = events.map(e => {
    const date = e.event_start ? new Date(e.event_start).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }) : 'TBD';
    const location = [e.city, e.state].filter(Boolean).join(', ') || 'TBD';
    return `• *${e.title}*\n   ${date} | ${location}\n   <${e.fq_url}|View in Splash>`;
  }).join('\n\n');

  const message = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🎉 ${events.length} New Event${events.length > 1 ? 's' : ''} Synced to Webflow`,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: eventList
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '👆 Please add descriptions manually in Webflow'
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error(`Slack notification failed: ${response.status}`);
    } else {
      console.log('✓ Slack notification sent');
    }
  } catch (error) {
    console.error(`Slack notification error: ${error.message}`);
  }
}

// ============================================
// SPLASH API
// ============================================

async function getSplashAccessToken() {
  const creds = {
    client_id: process.env.SPLASH_CLIENT_ID,
    client_secret: process.env.SPLASH_CLIENT_SECRET,
    username: process.env.SPLASH_USERNAME,
    password: process.env.SPLASH_PASSWORD,
  };

  const formData = new FormData();
  formData.append('client_id', creds.client_id);
  formData.append('client_secret', creds.client_secret);
  formData.append('grant_type', 'password');
  formData.append('scope', 'user');
  formData.append('username', creds.username);
  formData.append('password', creds.password);

  const response = await fetch(`${SPLASH_API_BASE}/oauth/v2/token`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Splash auth failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchSplashEvents(accessToken) {
  const response = await fetch(`${SPLASH_API_BASE}/events?upcoming=true&limit=50`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Splash events fetch failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.data || data;
}

// ============================================
// WEBFLOW API
// ============================================

async function fetchCollectionSchema() {
  const response = await fetch(
    `${WEBFLOW_API_BASE}/collections/${WEBFLOW_COLLECTION_ID}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
        'Accept': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webflow schema fetch failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.fields || [];
}

async function fetchExistingSplashIds() {
  const existingIds = new Set();
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetch(
      `${WEBFLOW_API_BASE}/collections/${WEBFLOW_COLLECTION_ID}/items?offset=${offset}&limit=${limit}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Webflow fetch failed: ${response.status} - ${text}`);
    }

    const data = await response.json();
    const items = data.items || [];

    for (const item of items) {
      const splashId = item.fieldData?.['splash-id'];
      if (splashId) {
        existingIds.add(splashId);
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return existingIds;
}

async function createWebflowEvent(eventData) {
  const response = await fetch(
    `${WEBFLOW_API_BASE}/collections/${WEBFLOW_COLLECTION_ID}/items`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        isArchived: false,
        isDraft: true,
        fieldData: eventData,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webflow create failed: ${response.status} - ${text}`);
  }

  return response.json();
}

// ============================================
// FIELD MAPPING
// ============================================

function mapSplashToWebflow(splashEvent, fieldSlugs) {
  const title = splashEvent.title || 'Untitled Event';

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);

  let eventDate = null;
  let eventTime = '';

  if (splashEvent.event_start) {
    const dateObj = new Date(splashEvent.event_start);
    if (!isNaN(dateObj.getTime())) {
      eventDate = dateObj.toISOString();
      eventTime = dateObj.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
  }

  const fieldData = {
    'name': title,
    'slug': slug,
  };

  if (fieldSlugs.has('splash-id')) {
    fieldData['splash-id'] = String(splashEvent.id);
  }

  if (fieldSlugs.has('splash-url') && splashEvent.fq_url) {
    fieldData['splash-url'] = splashEvent.fq_url;
  }

  if (fieldSlugs.has('date') && eventDate) {
    fieldData['date'] = eventDate;
  }
  if (fieldSlugs.has('time') && eventTime) {
    fieldData['time'] = eventTime;
  }

  // Add thumbnail (convert HTTP to HTTPS for Webflow)
  let imageUrl = splashEvent.event_setting?.header_image;
  if (imageUrl && imageUrl.startsWith('http://')) {
    imageUrl = imageUrl.replace('http://', 'https://');
  }
  if (fieldSlugs.has('thumbnail') && imageUrl) {
    fieldData['thumbnail'] = { url: imageUrl };
  }

  // Add location fields
  const city = splashEvent.city || '';
  const state = splashEvent.state || '';

  for (const citySlug of ['location-city', 'location---city', 'locationcity']) {
    if (fieldSlugs.has(citySlug) && city) {
      fieldData[citySlug] = city;
      break;
    }
  }

  for (const stateSlug of ['location-state', 'location---state', 'location---state-2', 'locationstate']) {
    if (fieldSlugs.has(stateSlug) && state) {
      fieldData[stateSlug] = state;
      break;
    }
  }

  // Add event type
  const eventType = splashEvent.event_type?.name || '';
  for (const typeSlug of ['event-type', 'event-type-2', 'eventtype', 'type']) {
    if (fieldSlugs.has(typeSlug) && eventType) {
      fieldData[typeSlug] = eventType;
      break;
    }
  }

  return fieldData;
}

// ============================================
// MAIN SYNC
// ============================================

async function sync() {
  console.log(`[${new Date().toISOString()}] Starting Splash → Webflow sync...`);

  const required = [
    'SPLASH_CLIENT_ID',
    'SPLASH_CLIENT_SECRET',
    'SPLASH_USERNAME',
    'SPLASH_PASSWORD',
    'WEBFLOW_API_TOKEN',
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  // Fetch Webflow collection schema
  const fields = await fetchCollectionSchema();
  const fieldSlugs = new Set(fields.map(f => f.slug));

  // Auth with Splash
  const accessToken = await getSplashAccessToken();
  console.log('✓ Splash auth successful');

  // Fetch events from Splash
  const allSplashEvents = await fetchSplashEvents(accessToken);
  const splashEvents = allSplashEvents.filter(event => event.published === true);
  console.log(`✓ Found ${splashEvents.length} published events (${allSplashEvents.length - splashEvents.length} templates excluded)`);

  // Get existing Splash IDs from Webflow
  const existingIds = await fetchExistingSplashIds();
  console.log(`✓ Found ${existingIds.size} existing events in Webflow`);

  // Filter to new events only
  const newEvents = splashEvents.filter(event => !existingIds.has(String(event.id)));
  console.log(`→ ${newEvents.length} new events to sync`);

  if (newEvents.length === 0) {
    console.log('Nothing to sync. Done.');
    return { synced: 0, total: splashEvents.length };
  }

  // Create new events in Webflow
  let synced = 0;
  const syncedEvents = [];
  const errors = [];

  for (const event of newEvents) {
    try {
      const fieldData = mapSplashToWebflow(event, fieldSlugs);
      await createWebflowEvent(fieldData);
      synced++;
      syncedEvents.push(event);
      console.log(`✓ Created: ${fieldData.name}`);

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (error) {
      console.error(`✗ Failed to create event ${event.id}: ${error.message}`);
      errors.push({ eventId: event.id, error: error.message });
    }
  }

  console.log(`\n[${new Date().toISOString()}] Sync complete: ${synced}/${newEvents.length} events created`);

  // Send Slack notification for synced events
  if (syncedEvents.length > 0) {
    await sendSlackNotification(syncedEvents);
  }

  if (errors.length > 0) {
    console.log('Errors:', errors);
  }

  return { synced, errors, total: splashEvents.length };
}

// Run if called directly
sync().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});

module.exports = { sync };

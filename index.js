/**
 * Splash → Webflow Event Sync
 *
 * Polls Splash for events and creates them in Webflow CMS.
 * Uses Splash-ID field to prevent duplicates.
 *
 * Environment variables required:
 * - SPLASH_CLIENT_ID
 * - SPLASH_CLIENT_SECRET
 * - SPLASH_USERNAME (your Splash login email)
 * - SPLASH_PASSWORD (your Splash login password)
 * - WEBFLOW_API_TOKEN
 * - WEBFLOW_COLLECTION_ID (default: 69650c17f7e5c3ac3938b16d)
 */

const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID || '69650c17f7e5c3ac3938b16d';
const SPLASH_API_BASE = 'https://api.splashthat.com';
const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';

// ============================================
// SPLASH API
// ============================================

async function getSplashAccessToken() {
  // Debug: log credential info (lengths and first/last chars only)
  const creds = {
    client_id: process.env.SPLASH_CLIENT_ID,
    client_secret: process.env.SPLASH_CLIENT_SECRET,
    username: process.env.SPLASH_USERNAME,
    password: process.env.SPLASH_PASSWORD,
  };

  console.log('Credential check:');
  for (const [key, val] of Object.entries(creds)) {
    if (val) {
      console.log(`  ${key}: len=${val.length}, starts="${val[0]}", ends="${val[val.length - 1]}"`);
    } else {
      console.log(`  ${key}: MISSING or empty`);
    }
  }

  // Splash API uses multipart/form-data for OAuth
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
  // Fetch upcoming/recent events - adjust query params as needed
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
  
  // Splash API typically returns { data: [...events] } or just [...events]
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
  // Get all existing events from Webflow to check for duplicates
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
      // The field slug for "Splash-ID" is likely "splash-id"
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
        isDraft: true, // Create as draft for review
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
  /**
   * Map Splash event fields to Webflow collection fields.
   * Only includes fields that exist in the Webflow schema.
   */

  const title = splashEvent.title || 'Untitled Event';

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);

  // Parse date/time from event_start
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

  // Start with required fields only
  const fieldData = {
    'name': title,
    'slug': slug,
  };

  // Add splash-id if it exists in schema
  if (fieldSlugs.has('splash-id')) {
    fieldData['splash-id'] = String(splashEvent.id);
  }

  // Add splash-url if it exists
  if (fieldSlugs.has('splash-url') && splashEvent.fq_url) {
    fieldData['splash-url'] = splashEvent.fq_url;
  }

  // Add date/time if they exist
  if (fieldSlugs.has('date') && eventDate) {
    fieldData['date'] = eventDate;
  }
  if (fieldSlugs.has('time') && eventTime) {
    fieldData['time'] = eventTime;
  }

  // Add thumbnail if it exists (convert HTTP to HTTPS for Webflow)
  let imageUrl = splashEvent.event_setting?.header_image;
  if (imageUrl && imageUrl.startsWith('http://')) {
    imageUrl = imageUrl.replace('http://', 'https://');
  }
  console.log(`  Thumbnail check: fieldSlugs has 'thumbnail'=${fieldSlugs.has('thumbnail')}, imageUrl=${imageUrl || 'none'}`);
  if (fieldSlugs.has('thumbnail') && imageUrl) {
    fieldData['thumbnail'] = { url: imageUrl };
    console.log(`  Added thumbnail: ${imageUrl}`);
  }

  // Add location fields if they exist (trying different slug patterns)
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

  // Add description if it exists
  for (const descSlug of ['description', 'description-2', 'event-description']) {
    if (fieldSlugs.has(descSlug) && splashEvent.description_text) {
      fieldData[descSlug] = splashEvent.description_text;
      break;
    }
  }

  // Add event type if it exists
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

  // Validate environment
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

  // 0. Fetch Webflow collection schema to see field slugs
  console.log('Fetching Webflow collection schema...');
  const fields = await fetchCollectionSchema();
  const fieldSlugs = new Set(fields.map(f => f.slug));
  console.log('Webflow field slugs:', Array.from(fieldSlugs).join(', '));

  // 1. Auth with Splash
  console.log('Authenticating with Splash...');
  const accessToken = await getSplashAccessToken();
  console.log('✓ Splash auth successful');

  // 2. Fetch events from Splash
  console.log('Fetching events from Splash...');
  const allSplashEvents = await fetchSplashEvents(accessToken);
  console.log(`✓ Found ${allSplashEvents.length} total events in Splash`);

  // Filter to only published events (exclude templates)
  const splashEvents = allSplashEvents.filter(event => event.published === true);
  console.log(`✓ ${splashEvents.length} are published (excluding ${allSplashEvents.length - splashEvents.length} templates)`);

  // Debug: log event info
  console.log('Events to consider:');
  for (const event of splashEvents) {
    const headerImg = event.event_setting?.header_image || 'none';
    console.log(`  - ${event.title}`);
    console.log(`    published=${event.published}`);
    console.log(`    event_type=${JSON.stringify(event.event_type)}`);
    console.log(`    city="${event.city || ''}" state="${event.state || ''}"`);
    console.log(`    header_image=${headerImg}`);
  }

  // 3. Get existing Splash IDs from Webflow
  console.log('Checking existing events in Webflow...');
  const existingIds = await fetchExistingSplashIds();
  console.log(`✓ Found ${existingIds.size} existing events in Webflow`);

  // 4. Filter to new events only
  const newEvents = splashEvents.filter(event => !existingIds.has(String(event.id)));
  console.log(`→ ${newEvents.length} new events to sync`);

  if (newEvents.length === 0) {
    console.log('Nothing to sync. Done.');
    return { synced: 0, total: splashEvents.length };
  }

  // 5. Create new events in Webflow
  let synced = 0;
  const errors = [];

  for (const event of newEvents) {
    try {
      const fieldData = mapSplashToWebflow(event, fieldSlugs);

      if (process.env.DEBUG) {
        console.log('Mapped field data:', JSON.stringify(fieldData, null, 2));
      }

      await createWebflowEvent(fieldData);
      synced++;
      console.log(`✓ Created: ${fieldData.name}`);
      
      // Rate limiting - Splash: 2 req/s, Webflow: 60 req/min
      await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (error) {
      console.error(`✗ Failed to create event ${event.id}: ${error.message}`);
      errors.push({ eventId: event.id, error: error.message });
    }
  }

  console.log(`\n[${new Date().toISOString()}] Sync complete: ${synced}/${newEvents.length} events created`);
  
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

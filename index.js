/**
 * Splash → Webflow Event Sync
 * 
 * Polls Splash for events and creates them in Webflow CMS.
 * Uses Splash-ID field to prevent duplicates.
 * 
 * Environment variables required:
 * - SPLASH_CLIENT_ID
 * - SPLASH_CLIENT_SECRET
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
  const response = await fetch(`${SPLASH_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SPLASH_CLIENT_ID,
      client_secret: process.env.SPLASH_CLIENT_SECRET,
    }),
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

function mapSplashToWebflow(splashEvent) {
  /**
   * Map Splash event fields to Webflow collection fields.
   * 
   * Webflow fields (from your screenshot):
   * - name (Plain text) - required
   * - slug (Plain text) - auto-generated
   * - date (Date/Time)
   * - time (Plain text)
   * - location-city (Plain text)
   * - location-state (Plain text)
   * - thumbnail (Image)
   * - splash-url (Link)
   * - featured (Switch)
   * - splash-id (Plain text)
   * - description (Rich text)
   * - event-type (Plain text)
   * 
   * Adjust the splash field names below based on actual API response.
   * Run with DEBUG=true to see raw Splash data.
   */

  const title = splashEvent.title || splashEvent.name || 'Untitled Event';
  
  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);

  // Parse date/time - Splash typically uses ISO format or separate fields
  let eventDate = null;
  let eventTime = '';
  
  if (splashEvent.event_start || splashEvent.start_date || splashEvent.date) {
    const dateStr = splashEvent.event_start || splashEvent.start_date || splashEvent.date;
    const dateObj = new Date(dateStr);
    if (!isNaN(dateObj.getTime())) {
      eventDate = dateObj.toISOString();
      eventTime = dateObj.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    }
  }

  // Location parsing - Splash may nest this
  const venue = splashEvent.venue || splashEvent.location || {};
  const locationCity = venue.city || splashEvent.city || '';
  const locationState = venue.state || splashEvent.state || '';

  // Build the field data object
  const fieldData = {
    'name': title,
    'slug': slug,
    'splash-id': String(splashEvent.id),
    'splash-url': splashEvent.url || splashEvent.event_url || splashEvent.registration_url || '',
    'description': splashEvent.description || splashEvent.about || '',
    'event-type': splashEvent.event_type || splashEvent.type || '',
    'featured': false,
  };

  // Only add optional fields if they have values
  if (eventDate) fieldData['date'] = eventDate;
  if (eventTime) fieldData['time'] = eventTime;
  if (locationCity) fieldData['location-city'] = locationCity;
  if (locationState) fieldData['location-state'] = locationState;

  // Image handling - Webflow needs a URL for images
  const imageUrl = splashEvent.image_url || splashEvent.thumbnail || splashEvent.photo?.url;
  if (imageUrl) {
    fieldData['thumbnail'] = { url: imageUrl };
  }

  return fieldData;
}

// ============================================
// MAIN SYNC
// ============================================

async function sync() {
  console.log(`[${new Date().toISOString()}] Starting Splash → Webflow sync...`);

  // Validate environment
  const required = ['SPLASH_CLIENT_ID', 'SPLASH_CLIENT_SECRET', 'WEBFLOW_API_TOKEN'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  // 1. Auth with Splash
  console.log('Authenticating with Splash...');
  const accessToken = await getSplashAccessToken();
  console.log('✓ Splash auth successful');

  // 2. Fetch events from Splash
  console.log('Fetching events from Splash...');
  const splashEvents = await fetchSplashEvents(accessToken);
  console.log(`✓ Found ${splashEvents.length} events in Splash`);

  if (process.env.DEBUG) {
    console.log('Raw Splash event sample:', JSON.stringify(splashEvents[0], null, 2));
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
      const fieldData = mapSplashToWebflow(event);
      
      if (process.env.DEBUG) {
        console.log('Mapped field data:', JSON.stringify(fieldData, null, 2));
      }

      await createWebflowEvent(fieldData);
      synced++;
      console.log(`✓ Created: ${fieldData.name}`);
      
      // Rate limiting - Webflow allows 60 requests/min
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

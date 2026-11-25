// OpenAPI 3.1 description of the public API, served at /openapi.json and rendered at /docs.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });
const ok = (schema, description = 'OK') => ({ description, ...json(schema) });
const body = (schema) => ({ required: true, ...json(schema) });
const pathId = (name, description) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', format: 'uuid' },
});
const queryParam = (name, schema, description, required = false) => ({ name, in: 'query', required, description, schema });
const noContent = { description: 'No content' };
const errors = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  404: { $ref: '#/components/responses/NotFound' },
  429: { $ref: '#/components/responses/RateLimited' },
};
const limitBefore = [
  queryParam('limit', { type: 'integer', minimum: 1, maximum: 50, default: 20 }, 'Page size'),
  queryParam('before', { type: 'string', format: 'date-time' }, "Cursor: pass the last item's startedAt"),
];
const op = (tag, summary, extra = {}) => ({ tags: [tag], summary, ...extra });

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Nex Map API',
    version: '1.0.0',
    description: `Maps, friends' live locations, places and activity tracking.

**Authentication.** Every endpoint except \`/v1/auth/*\` needs one of:
- \`Authorization: Bearer <token>\`: the token from \`/v1/auth/login\` (what the Nex Map app uses).
- \`X-API-Key: nex_...\`: a developer key created at \`POST /v1/api-keys\`. A key acts as the user who created it.
  Keys with only the \`read\` scope may call GET endpoints; \`write\` is needed for everything else.
  Managing API keys and changing the password require a signed-in token, never an API key.

**Rate limits.** API keys: 120 requests per minute per key. Signed-in app users: 600 per minute per IP.
Login and registration: 30 per minute per IP. Remaining quota is in the \`RateLimit\` response header;
going over returns \`429\`.

**Errors** always look like \`{"error": {"code": "not_found", "message": "...", "details": [...]}}\`.

**Real-time.** Connect with Socket.IO to the same host, passing \`{ auth: { token } }\` (a token or an API key).
Send \`location:update\` with a Location body to share your position; receive \`friend:location\`,
\`friend:online\`, \`friend:offline\`, \`friend:ghost\`, \`friend:request\`, \`friend:accepted\`,
\`friend:removed\`, \`friend:checkin\`, \`message:new\`, \`message:read\` and \`activity:kudos\`.

**Units.** Distances in meters, durations in seconds, speeds in meters per second, coordinates in WGS84 degrees.`,
  },
  servers: [{ url: '/', description: 'This server' }],
  security: [{ bearerAuth: [] }, { apiKey: [] }],
  tags: [
    { name: 'Auth' },
    { name: 'Me' },
    { name: 'Users' },
    { name: 'Friends' },
    { name: 'Activities' },
    { name: 'Places' },
    { name: 'Geocoding' },
    { name: 'Messages' },
    { name: 'API keys' },
  ],
  paths: {
    '/v1/auth/register': {
      post: {
        ...op('Auth', 'Create an account'),
        security: [],
        requestBody: body({
          type: 'object',
          required: ['name', 'username', 'email', 'password'],
          properties: {
            name: { type: 'string', maxLength: 80 },
            username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_.]+$' },
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        }),
        responses: { 201: ok(ref('Session'), 'Created'), 409: { description: 'Email or username taken' }, ...errors },
      },
    },
    '/v1/auth/login': {
      post: {
        ...op('Auth', 'Sign in with email or username'),
        security: [],
        requestBody: body({
          type: 'object',
          required: ['login', 'password'],
          properties: { login: { type: 'string', description: 'Email or username' }, password: { type: 'string' } },
        }),
        responses: { 200: ok(ref('Session')), ...errors },
      },
    },
    '/v1/me': {
      get: { ...op('Me', 'Your profile'), responses: { 200: ok(ref('Me')), ...errors } },
      patch: {
        ...op('Me', 'Update your profile or turn ghost mode on/off'),
        description: 'In ghost mode your location stops updating for friends; they keep seeing where you were when you turned it on.',
        requestBody: body({
          type: 'object',
          properties: {
            name: { type: 'string' },
            username: { type: 'string' },
            bio: { type: 'string', maxLength: 300 },
            avatarUrl: { type: ['string', 'null'], format: 'uri' },
            ghostMode: { type: 'boolean' },
          },
        }),
        responses: { 200: ok(ref('Me')), ...errors },
      },
    },
    '/v1/me/password': {
      put: {
        ...op('Me', 'Change password (signed-in token only)'),
        requestBody: body({
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8 } },
        }),
        responses: { 204: noContent, ...errors },
      },
    },
    '/v1/me/location': {
      put: {
        ...op('Me', 'Share your current location with friends'),
        requestBody: body(ref('LocationInput')),
        responses: {
          200: ok({
            type: 'object',
            properties: {
              shared: { type: 'boolean', description: 'false while ghost mode is on' },
              location: { oneOf: [ref('Location'), { type: 'null' }] },
            },
          }),
          ...errors,
        },
      },
    },
    '/v1/me/stats': {
      get: {
        ...op('Me', 'Your activity totals for the last 7 days, 28 days and all time'),
        responses: { 200: ok(ref('Stats')), ...errors },
      },
    },
    '/v1/users/search': {
      get: {
        ...op('Users', 'Find people by username or name'),
        parameters: [
          queryParam('q', { type: 'string', minLength: 1 }, 'Search text', true),
          queryParam('limit', { type: 'integer', maximum: 50, default: 20 }, 'Max results'),
        ],
        responses: { 200: ok({ type: 'object', properties: { users: { type: 'array', items: ref('User') } } }), ...errors },
      },
    },
    '/v1/users/{id}': {
      get: {
        ...op('Users', "A user's public profile and your relationship with them"),
        parameters: [pathId('id', 'User id')],
        responses: {
          200: ok({
            allOf: [
              ref('User'),
              {
                type: 'object',
                properties: { friendship: { enum: ['self', 'none', 'friends', 'request_sent', 'request_received'] } },
              },
            ],
          }),
          ...errors,
        },
      },
    },
    '/v1/users/{id}/activities': {
      get: {
        ...op('Activities', "A user's activities that you are allowed to see"),
        parameters: [pathId('id', 'User id'), ...limitBefore],
        responses: { 200: ok(ref('ActivityList')), ...errors },
      },
    },
    '/v1/friends': {
      get: {
        ...op('Friends', 'Your friends with their last shared location'),
        responses: {
          200: ok({ type: 'object', properties: { friends: { type: 'array', items: ref('Friend') } } }),
          ...errors,
        },
      },
    },
    '/v1/friends/requests': {
      get: {
        ...op('Friends', 'Pending friend requests'),
        responses: {
          200: ok({
            type: 'object',
            properties: {
              incoming: { type: 'array', items: ref('FriendRequest') },
              outgoing: { type: 'array', items: ref('FriendRequest') },
            },
          }),
          ...errors,
        },
      },
      post: {
        ...op('Friends', 'Send a friend request', {
          description: 'If that person already sent you a request, this accepts it instead.',
        }),
        requestBody: body({ type: 'object', required: ['userId'], properties: { userId: { type: 'string', format: 'uuid' } } }),
        responses: {
          201: ok(ref('FriendRequestStatus'), 'Request sent'),
          200: ok(ref('FriendRequestStatus'), 'Their request was accepted'),
          409: { description: 'Already friends or already requested' },
          ...errors,
        },
      },
    },
    '/v1/friends/requests/{id}/accept': {
      post: {
        ...op('Friends', 'Accept a friend request sent to you'),
        parameters: [pathId('id', 'Request id')],
        responses: { 200: ok(ref('FriendRequestStatus')), ...errors },
      },
    },
    '/v1/friends/requests/{id}': {
      delete: {
        ...op('Friends', 'Decline a request sent to you, or cancel one you sent'),
        parameters: [pathId('id', 'Request id')],
        responses: { 204: noContent, ...errors },
      },
    },
    '/v1/friends/{userId}': {
      delete: {
        ...op('Friends', 'Remove a friend'),
        parameters: [pathId('userId', 'Friend user id')],
        responses: { 204: noContent, ...errors },
      },
    },
    '/v1/activities': {
      get: {
        ...op('Activities', "Feed: your activities and your friends'"),
        parameters: limitBefore,
        responses: { 200: ok(ref('ActivityList')), ...errors },
      },
      post: {
        ...op('Activities', 'Upload a recorded activity', {
          description: 'Distance, duration, moving time, elevation gain and speeds are computed from the points.',
        }),
        requestBody: body({
          type: 'object',
          required: ['type', 'points'],
          properties: {
            type: ref('ActivityType'),
            title: { type: 'string', maxLength: 120, description: 'Defaults to the type, e.g. "Run"' },
            description: { type: 'string', maxLength: 2000 },
            visibility: ref('Visibility'),
            points: { type: 'array', minItems: 2, maxItems: 50000, items: ref('TrackPoint') },
          },
        }),
        responses: { 201: ok(ref('Activity'), 'Created'), ...errors },
      },
    },
    '/v1/activities/{id}': {
      get: {
        ...op('Activities', 'An activity with all its GPS points'),
        parameters: [pathId('id', 'Activity id')],
        responses: {
          200: ok({ allOf: [ref('Activity'), { type: 'object', properties: { points: { type: 'array', items: ref('TrackPoint') } } }] }),
          ...errors,
        },
      },
      patch: {
        ...op('Activities', 'Edit your activity'),
        parameters: [pathId('id', 'Activity id')],
        requestBody: body({
          type: 'object',
          properties: {
            type: ref('ActivityType'),
            title: { type: 'string' },
            description: { type: 'string' },
            visibility: ref('Visibility'),
          },
        }),
        responses: { 200: ok(ref('Activity')), ...errors },
      },
      delete: {
        ...op('Activities', 'Delete your activity'),
        parameters: [pathId('id', 'Activity id')],
        responses: { 204: noContent, ...errors },
      },
    },
    '/v1/activities/{id}/kudos': {
      post: {
        ...op('Activities', 'Give kudos'),
        parameters: [pathId('id', 'Activity id')],
        responses: { 200: ok(ref('Kudos')), ...errors },
      },
      delete: {
        ...op('Activities', 'Take back kudos'),
        parameters: [pathId('id', 'Activity id')],
        responses: { 200: ok(ref('Kudos')), ...errors },
      },
    },
    '/v1/places/nearby': {
      get: {
        ...op('Places', 'Places around a point, nearest first'),
        parameters: [
          queryParam('lat', { type: 'number' }, 'Latitude', true),
          queryParam('lng', { type: 'number' }, 'Longitude', true),
          queryParam('radius', { type: 'number', maximum: 50000, default: 1000 }, 'Meters'),
          queryParam('category', ref('PlaceCategory'), 'Only this category'),
          queryParam('limit', { type: 'integer', maximum: 100, default: 50 }, 'Max results'),
        ],
        responses: { 200: ok({ type: 'object', properties: { places: { type: 'array', items: ref('Place') } } }), ...errors },
      },
    },
    '/v1/places': {
      post: {
        ...op('Places', 'Add a place to the map'),
        requestBody: body({
          type: 'object',
          required: ['name', 'lat', 'lng'],
          properties: {
            name: { type: 'string', maxLength: 120 },
            category: ref('PlaceCategory'),
            address: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
        }),
        responses: { 201: ok(ref('Place'), 'Created'), ...errors },
      },
    },
    '/v1/places/{id}': {
      get: { ...op('Places', 'A place'), parameters: [pathId('id', 'Place id')], responses: { 200: ok(ref('Place')), ...errors } },
    },
    '/v1/places/{id}/checkins': {
      post: {
        ...op('Places', 'Check in at a place (friends are notified)'),
        parameters: [pathId('id', 'Place id')],
        responses: { 201: ok(ref('Checkin'), 'Created'), ...errors },
      },
    },
    '/v1/geocode/search': {
      get: {
        ...op('Geocoding', 'Search addresses and points of interest (OpenStreetMap data)'),
        parameters: [
          queryParam('q', { type: 'string' }, 'What to look for', true),
          queryParam('lat', { type: 'number' }, 'Prefer results near this latitude'),
          queryParam('lng', { type: 'number' }, 'Prefer results near this longitude'),
          queryParam('limit', { type: 'integer', maximum: 20, default: 10 }, 'Max results'),
          queryParam('lang', { type: 'string' }, 'Result language, e.g. "uz" or "en"'),
        ],
        responses: {
          200: ok({ type: 'object', properties: { results: { type: 'array', items: ref('GeocodeResult') } } }),
          502: { description: 'Upstream geocoder unavailable' },
          ...errors,
        },
      },
    },
    '/v1/geocode/reverse': {
      get: {
        ...op('Geocoding', 'Address of a point'),
        parameters: [
          queryParam('lat', { type: 'number' }, 'Latitude', true),
          queryParam('lng', { type: 'number' }, 'Longitude', true),
          queryParam('lang', { type: 'string' }, 'Result language'),
        ],
        responses: {
          200: ok({ type: 'object', properties: { result: { oneOf: [ref('GeocodeResult'), { type: 'null' }] } } }),
          502: { description: 'Upstream geocoder unavailable' },
          ...errors,
        },
      },
    },
    '/v1/messages/conversations': {
      get: {
        ...op('Messages', 'Your conversations, most recent first'),
        responses: {
          200: ok({
            type: 'object',
            properties: {
              conversations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { user: ref('User'), lastMessage: ref('Message'), unreadCount: { type: 'integer' } },
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    '/v1/messages/{userId}': {
      get: {
        ...op('Messages', 'Messages with a user, newest first (marks theirs as read)'),
        parameters: [
          pathId('userId', 'The other user'),
          queryParam('limit', { type: 'integer', maximum: 100, default: 50 }, 'Page size'),
          queryParam('before', { type: 'string' }, "Cursor: pass the oldest message's id"),
        ],
        responses: { 200: ok({ type: 'object', properties: { messages: { type: 'array', items: ref('Message') } } }), ...errors },
      },
      post: {
        ...op('Messages', 'Send a message to a friend'),
        parameters: [pathId('userId', 'The friend')],
        requestBody: body({ type: 'object', required: ['body'], properties: { body: { type: 'string', maxLength: 4000 } } }),
        responses: { 201: ok(ref('Message'), 'Sent'), 403: { description: 'Not friends' }, ...errors },
      },
    },
    '/v1/api-keys': {
      get: {
        ...op('API keys', 'Your active API keys (signed-in token only)'),
        responses: { 200: ok({ type: 'object', properties: { apiKeys: { type: 'array', items: ref('ApiKey') } } }), ...errors },
      },
      post: {
        ...op('API keys', 'Create an API key (signed-in token only)', {
          description: 'The full key is in the response only once. Store it safely.',
        }),
        requestBody: body({
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 60 },
            scopes: { type: 'array', items: { enum: ['read', 'write'] }, default: ['read'] },
          },
        }),
        responses: {
          201: ok({ allOf: [ref('ApiKey'), { type: 'object', properties: { key: { type: 'string', example: 'nex_...' } } }] }, 'Created'),
          ...errors,
        },
      },
    },
    '/v1/api-keys/{id}': {
      delete: {
        ...op('API keys', 'Revoke an API key (signed-in token only)'),
        parameters: [pathId('id', 'API key id')],
        responses: { 204: noContent, ...errors },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    responses: {
      BadRequest: { description: 'Invalid input', ...json(ref('Error')) },
      Unauthorized: { description: 'Missing or invalid credentials', ...json(ref('Error')) },
      NotFound: { description: 'Not found', ...json(ref('Error')) },
      RateLimited: { description: 'Too many requests', ...json(ref('Error')) },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          username: { type: 'string' },
          name: { type: 'string' },
          bio: { type: 'string' },
          avatarUrl: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Me: {
        allOf: [ref('User'), { type: 'object', properties: { email: { type: 'string' }, ghostMode: { type: 'boolean' } } }],
      },
      Session: { type: 'object', properties: { token: { type: 'string' }, user: ref('Me') } },
      LocationInput: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          accuracy: { type: ['number', 'null'], description: 'Meters' },
          speed: { type: ['number', 'null'], description: 'Meters per second' },
          heading: { type: ['number', 'null'], description: 'Degrees from north' },
          battery: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
        },
      },
      Location: {
        allOf: [
          ref('LocationInput'),
          { type: 'object', properties: { userId: { type: 'string', format: 'uuid' }, updatedAt: { type: 'string', format: 'date-time' } } },
        ],
      },
      Friend: {
        allOf: [
          ref('User'),
          {
            type: 'object',
            properties: {
              friendsSince: { type: 'string', format: 'date-time' },
              location: { oneOf: [ref('Location'), { type: 'null' }] },
            },
          },
        ],
      },
      FriendRequest: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, createdAt: { type: 'string', format: 'date-time' }, user: ref('User') },
      },
      FriendRequestStatus: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, status: { enum: ['pending', 'accepted'] } },
      },
      ActivityType: { enum: ['run', 'ride', 'walk', 'hike'] },
      Visibility: { enum: ['public', 'friends', 'private'], default: 'friends' },
      TrackPoint: {
        type: 'object',
        required: ['lat', 'lng', 't'],
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
          t: { description: 'Time: ISO 8601 string or unix milliseconds', oneOf: [{ type: 'string', format: 'date-time' }, { type: 'integer' }] },
          ele: { type: ['number', 'null'], description: 'Elevation in meters' },
        },
      },
      Activity: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user: ref('User'),
          type: ref('ActivityType'),
          title: { type: 'string' },
          description: { type: 'string' },
          visibility: ref('Visibility'),
          startedAt: { type: 'string', format: 'date-time' },
          endedAt: { type: 'string', format: 'date-time' },
          distanceM: { type: 'number' },
          durationS: { type: 'integer' },
          movingTimeS: { type: 'integer' },
          elevationGainM: { type: 'number' },
          avgSpeedMps: { type: 'number' },
          maxSpeedMps: { type: 'number' },
          avgPaceSPerKm: { type: ['integer', 'null'], description: 'Seconds per kilometer' },
          preview: { type: 'array', description: 'Up to 100 [lat, lng] pairs for drawing the route', items: { type: 'array', items: { type: 'number' } } },
          kudosCount: { type: 'integer' },
          hasKudos: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ActivityList: { type: 'object', properties: { activities: { type: 'array', items: ref('Activity') } } },
      Kudos: { type: 'object', properties: { kudosCount: { type: 'integer' }, hasKudos: { type: 'boolean' } } },
      Totals: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          distanceM: { type: 'number' },
          movingTimeS: { type: 'integer' },
          elevationGainM: { type: 'number' },
        },
      },
      Stats: {
        type: 'object',
        properties: {
          week: ref('Totals'),
          month: ref('Totals'),
          all: ref('Totals'),
          byType: {
            type: 'object',
            additionalProperties: { type: 'object', properties: { week: ref('Totals'), month: ref('Totals'), all: ref('Totals') } },
          },
        },
      },
      PlaceCategory: { enum: ['cafe', 'restaurant', 'park', 'gym', 'sport', 'shop', 'school', 'work', 'home', 'other'] },
      Place: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          category: ref('PlaceCategory'),
          address: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          checkinCount: { type: 'integer' },
          distanceM: { type: 'integer', description: 'Only in nearby results' },
          createdBy: { type: ['string', 'null'], format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Checkin: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          place: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } } },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      GeocodeResult: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          displayName: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          category: { type: ['string', 'null'] },
          type: { type: ['string', 'null'] },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          senderId: { type: 'string', format: 'uuid' },
          recipientId: { type: 'string', format: 'uuid' },
          body: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          readAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ApiKey: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          prefix: { type: 'string', description: 'First characters of the key, to recognize it' },
          scopes: { type: 'array', items: { enum: ['read', 'write'] } },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
};

// Central configuration. Everything here is safe to commit: no secrets, demo-only contacts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.CARE_DB_PATH || path.join(root, 'data', 'care-hub.db'),
  publicDir: path.join(root, 'public'),

  isProduction: process.env.NODE_ENV === 'production',
  trustProxy: Number(process.env.TRUST_PROXY || 0),

  // Counselor portal passcode. Demo default only - production refuses to start without a real one.
  adminPasscode: process.env.ADMIN_PASSCODE || 'counselor-demo',
  usingDemoPasscode: !process.env.ADMIN_PASSCODE || process.env.ADMIN_PASSCODE === 'counselor-demo' || process.env.ADMIN_PASSCODE.length < 12,

  // Claude integration. "auto" uses Claude when credentials are present and falls back to the
  // deterministic engine otherwise; "off" forces the offline engine (useful for demos/tests).
  llmMode: (process.env.CARE_LLM || 'auto').toLowerCase(),
  model: 'claude-opus-5-5',

  // Raw narratives are purged once sanitization finishes (privacy-first default).
  retainRawContent: process.env.RETAIN_RAW_CONTENT === 'true',

  maxNarrativeLength: 3000,
  similarityThreshold: 0.8,
  clusterWindowDays: 7,
  systemicClusterSize: 4, // a cluster this large is treated as systemic harassment (severity >= 4)
  escalationThreshold: 4,

  categories: ['Bullying', 'Cyberbullying', 'Peer Pressure', 'Campus Safety', 'Mental Health'],

  // Fixed zone list keeps clustering reliable and stops free-text locations from leaking identities.
  locations: [
    '3rd Floor Hallway',
    'Science Lab',
    'Gym',
    'Cafeteria',
    'Library',
    'Restrooms',
    'Classroom',
    'Main Gate / Parking',
    'School Grounds / Field',
    'Online Section Chat',
    'Social Media (Off-campus)',
    'School Bus / Commute',
  ],

  emergencyContacts: [
    { label: 'NCMH Crisis Hotline', number: '1553', note: 'National Center for Mental Health - toll-free, 24/7' },
    { label: 'NCMH Crisis Hotline (mobile)', number: '0917-899-8727', note: '24/7' },
    { label: 'National Emergency Hotline', number: '911', note: 'Police, fire, medical' },
    // Placeholders - replace with the real campus numbers before any pilot.
    { label: 'Campus Security (demo placeholder)', number: 'Local 1234', note: 'Replace with your campus number' },
    { label: 'Guidance & Counseling Office (demo placeholder)', number: 'Local 2100', note: 'Replace with your campus number' },
  ],

  escalationTargets: {
    4: 'Guidance & Counseling Office (demo)',
    5: 'Guidance & Counseling Office + Campus Security (demo)',
  },
};

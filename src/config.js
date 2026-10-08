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

  // AI integration. "auto" uses an AI model when a key is present and falls back to the
  // deterministic engine otherwise; "off" forces the offline engine (useful for demos/tests).
  llmMode: (process.env.CARE_LLM || 'auto').toLowerCase(),
  // Which AI: "gemini", "anthropic", or "auto" (Gemini if GEMINI_API_KEY is set, else Claude).
  llmProvider: (process.env.CARE_LLM_PROVIDER || 'auto').toLowerCase(),
  // "gemini-flash-latest" is Google's alias for the current Flash model; pin a version via GEMINI_MODEL.
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  // Used when the main model is overloaded (HTTP 503). Set GEMINI_FALLBACK_MODEL= (empty) to disable.
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-lite-latest',
  anthropicModel: 'claude-opus-5-5',

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

  // "Need someone to talk to?" contacts, shown in three groups. The national lines are real and must
  // stay real (the header's one-tap "Helpline 1553" depends on them). Everything marked
  // `placeholder: true` uses a non-dialable placeholder like 09XX-XXX-XXXX - replace each with the
  // real number for your school and barangay before any pilot.
  emergencyContacts: [
    { group: 'crisis', label: 'NCMH Crisis Hotline', number: '1553', note: 'National Center for Mental Health - toll-free, 24/7' },
    { group: 'crisis', label: 'NCMH Crisis Hotline (mobile)', number: '0917-899-8727', note: '24/7' },
    { group: 'crisis', label: 'National Emergency Hotline', number: '911', note: 'Police, fire, medical' },

    { group: 'campus', label: 'Guidance & Counseling Office', number: 'Local XXXX', note: 'Talk to a counselor in confidence', placeholder: true },
    { group: 'campus', label: 'Student Council', number: '09XX-XXX-XXXX', note: 'Your SSG / SSLG / student council officers', placeholder: true },
    { group: 'campus', label: 'School Clinic', number: 'Local XXXX', note: 'If you are hurt or feeling unwell', placeholder: true },
    { group: 'campus', label: 'Campus Security', number: 'Local XXXX', note: 'Safety concerns on campus', placeholder: true },

    { group: 'community', label: 'Sangguniang Kabataan (SK)', number: '09XX-XXX-XXXX', note: "Your barangay's youth council", placeholder: true },
    { group: 'community', label: 'Barangay VAWC Desk', number: '09XX-XXX-XXXX', note: 'Violence against women and children - help at the barangay hall', placeholder: true },
  ],

  escalationTargets: {
    4: 'Guidance & Counseling Office (demo)',
    5: 'Guidance & Counseling Office + Campus Security (demo)',
  },
};

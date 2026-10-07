// Campus location normalization. Students may type a free-text location (with suggestions), but
// known zones and common aliases collapse to one canonical name so clustering and hotspots stay
// reliable, and anything else is scrubbed so a location can never carry a person's name.
import { config } from '../config.js';
import { scrubText } from './scrubber.js';

const ALIASES = {
  'Science Lab': ['science lab', 'science laboratory', 'chem lab', 'chemistry lab', 'bio lab', 'biology lab', 'physics lab', 'lab'],
  '3rd Floor Hallway': ['3rd floor', 'third floor', '3rd floor hallway', 'third floor hallway', '3f hallway'],
  Gym: ['gym', 'gymnasium', 'locker room', 'gym locker room', 'covered court'],
  Cafeteria: ['cafeteria', 'canteen', 'lunch area'],
  Library: ['library', 'lib'],
  Restrooms: ['restroom', 'restrooms', 'cr', 'comfort room', 'bathroom', 'toilet'],
  Classroom: ['classroom', 'class', 'room'],
  'Main Gate / Parking': ['main gate', 'gate', 'parking', 'parking lot'],
  'School Grounds / Field': ['field', 'school grounds', 'grounds', 'oval', 'quadrangle', 'quad'],
  'Online Section Chat': ['online section chat', 'section chat', 'group chat', 'gc', 'section gc', 'class gc', 'discord', 'messenger'],
  'Social Media (Off-campus)': ['social media', 'facebook', 'tiktok', 'instagram', 'twitter', 'x', 'online'],
  'School Bus / Commute': ['bus', 'school bus', 'commute', 'jeep', 'jeepney', 'tricycle', 'service'],
};

const LOOKUP = new Map();
for (const zone of config.locations) LOOKUP.set(zone.toLowerCase(), zone);
for (const [zone, aliases] of Object.entries(ALIASES)) for (const a of aliases) LOOKUP.set(a, zone);

/** Returns the canonical/scrubbed location, or null when nothing usable was given. */
export function normalizeLocation(input) {
  const cleaned = String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (cleaned.length < 2) return null;
  const key = cleaned.toLowerCase().replace(/^(the|at the|in the|near the)\s+/, '');
  if (LOOKUP.has(key)) return LOOKUP.get(key);
  const scrubbed = scrubText(cleaned).text;
  return scrubbed.charAt(0).toUpperCase() + scrubbed.slice(1);
}

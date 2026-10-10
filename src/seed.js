// SYNTHETIC DEMO DATA ONLY. Every name, number and event below is fictional and exists to show the
// redaction, clustering and triage pipeline working end-to-end. Never load real student data.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openDb, resetDb } from './db.js';
import { authorTokenFromSecret, submitPost } from './pipeline/ingest.js';

const HOUR = 3600 * 1000;

// [hoursAgo, author#, category, location, narrative]
const SEED_POSTS = [
  [26 * 24, 1, 'Campus Safety', '3rd Floor Hallway', 'The lights at the end of the 3rd floor hallway near the stairs have been out for two weeks. It gets really dark after 5pm and it feels unsafe walking there.'],
  [20 * 24, 2, 'Mental Health', 'Library', 'Finals season is honestly so heavy. I study in the library every night and still feel behind. If anyone else feels this way, you are not alone. Taking breaks actually helped me a bit.'],
  [9 * 24, 3, 'Peer Pressure', 'Gym', 'Some upperclassmen keep daring us to vape in the gym locker area after PE. I said no but they laughed at me and called me a baby.'],
  [6 * 24, 4, 'Peer Pressure', 'Gym', 'In the gym locker room people keep pressuring the younger students to try vapes after PE class. It happens almost every day now.'],
  [5 * 24, 5, 'Cyberbullying', 'Online Section Chat', 'Teasing and photo sharing reported in Chem lab - someone took pictures of a classmate during chemistry lab and posted them in the section group chat to mock her.'],
  [4 * 24, 6, 'Campus Safety', '3rd Floor Hallway', 'The railing beside the 3rd floor stairs is loose and wobbles when you hold it. With the lights out it is a real hazard, someone almost slipped yesterday.'],
  [4 * 24 - 5, 7, 'Bullying', 'Cafeteria', 'Paolo Mendoza and his barkada keep taking my seat at lunch and throwing my food away. It has been happening for weeks and I eat alone in the CR now.'],
  [3 * 24, 8, 'Peer Pressure', 'Gym', 'Upperclassmen in the gym told us we are not part of the team unless we try their vape. I feel pressured to go along with it.'],
  [3 * 24 - 8, 9, 'Mental Health', 'Classroom', 'I get anxiety attacks before our recitation in Ms. Villanueva\'s class. I do not want anyone in trouble, I just want to know if other people deal with this too.'],
  [2 * 24, 10, 'Peer Pressure', 'Gym', 'After PE, a group in the locker area keeps pushing first years to vape and blocks the door until they try it. Everyday this week.'],
  [2 * 24 - 3, 11, 'Cyberbullying', 'Social Media (Off-campus)', 'Someone made a fake account using edited photos of me and posts memes about me to laugh at me. It is so embarrassing. My number 0917 555 0142 was also posted.'],
  [36, 12, 'Bullying', 'School Grounds / Field', 'Some classmates keep making fun of how I talk during PE on the field. It is mostly teasing but it hurts.'],
  [30, 13, 'Bullying', 'Cafeteria', 'Let\'s expose the kids who bully people in the cafeteria, everyone go spam their accounts until they leave.'],
  [20, 14, 'Cyberbullying', 'Online Section Chat', 'Mark Santos and his clique from 3-B are sharing non-consensual photos of John Doe in our group chat and calling him names every afternoon during chemistry lab.'],
  [14, 15, 'Campus Safety', 'Main Gate / Parking', 'Cars speed through the main gate at dismissal and there is no guard directing traffic. A student almost got hit on Tuesday.'],
  [6, 16, 'Mental Health', 'Library', 'Small win: I finally talked to the guidance counselor about my stress. It was less scary than I thought. Highly recommend if you are struggling.'],
  [3, 17, 'Peer Pressure', 'Classroom', 'Some classmates pressure me to let them copy my homework every morning. When I refuse they ignore me the whole day.'],
];

const SEED_REACTIONS = [
  [2, ['support', 'heard', 'same', 'same', 'strength']],
  [16, ['support', 'strength', 'strength', 'heard']],
  [12, ['support', 'same', 'heard']],
  [1, ['same', 'same']],
  [17, ['support', 'heard']],
];

function demoSecret(n) {
  return crypto.createHash('sha256').update(`synthetic-demo-student-${n}`).digest('hex');
}

export async function seed(db) {
  const now = Date.now();
  const idsByIndex = [];
  for (const [hoursAgo, author, category, location_tag, narrative] of SEED_POSTS) {
    const result = await submitPost(db, {
      authorToken: authorTokenFromSecret(demoSecret(author)),
      category,
      location_tag,
      narrative,
      now: now - hoursAgo * HOUR,
      useLlm: false, // deterministic, offline seeding
    });
    idsByIndex.push(result.post_id);
  }

  // Counselor workflow examples.
  await db.run("UPDATE incident_clusters SET status = 'reviewing' WHERE location_tag = 'Gym'");

  for (const [postIndex, kinds] of SEED_REACTIONS) {
    for (const [i, kind] of kinds.entries()) {
      await db.run('INSERT INTO reactions (post_id, kind, author_token) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [idsByIndex[postIndex - 1], kind, authorTokenFromSecret(demoSecret(100 + i))]);
    }
  }
  return idsByIndex.length;
}

export async function seedIfEmpty(db) {
  if (process.env.CARE_SEED === 'false') return;
  const { n } = await db.get('SELECT COUNT(*)::int AS n FROM posts');
  if (n === 0) {
    const count = await seed(db);
    console.log(`[seed] loaded ${count} synthetic demo reports`);
  }
}

// `npm run seed` -> wipe and reload the synthetic dataset.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openDb();
  if (process.argv.includes('--reset')) await resetDb(db);
  const count = await seed(db);
  console.log(`[seed] loaded ${count} synthetic demo reports`);
  await db.close();
}

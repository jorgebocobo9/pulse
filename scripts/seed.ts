import { config as loadDotenv } from 'dotenv';
import { DEFAULT_DATABASE_PATH } from '../src/config.js';
import { openDatabase } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';
import { utcToday } from '../src/dates.js';

loadDotenv({ quiet: true });

// Only the database path is needed here, so seeding works before the Slack tokens are set up.
const path = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
const today = utcToday();

const db = openDatabase(path);
const { campaigns, metricRows } = seedDatabase(db, today);
db.close();

console.log(`Seeded ${campaigns} campaigns and ${metricRows} daily metric rows (90 days ending ${today}) into ${path}`);

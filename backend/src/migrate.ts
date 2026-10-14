import { loadConfig } from "./config.js";
import { Db, migrate } from "./db.js";

const config = loadConfig();
const db = new Db(config.databaseUrl);
try {
  const applied = await migrate(db, (m) => console.log("[migrate]", m));
  console.log(applied.length ? `[migrate] done, ${applied.length} applied` : "[migrate] already up to date");
} finally {
  await db.close();
}
